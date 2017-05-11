import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'
import FilePattern from './FilePattern'
import NodePattern from './NodePattern'
import TextPattern from './TextPattern'
import FileItem from './FileItem'
import NodeItem from './NodeItem'
import TextItem from './TextItem'

const fileCache = new Map<string, FileItem>()
const nodeCache = new Map<string, NodeItem>()

export function activate(context: vscode.ExtensionContext) {
    let filePatterns: Array<FilePattern>
    let nodePatterns: Array<NodePattern>
    let textPatterns: Array<TextPattern>
    let jsParserPlugins: Array<string>

    loadLocalConfiguration()

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.showAll', createCommand({ includeFiles: true, includeNodes: true, includeTexts: true })))
    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.showFiles', createCommand({ includeFiles: true, includeNodes: false, includeTexts: false })))
    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.showNodes', createCommand({ includeFiles: false, includeNodes: true, includeTexts: false })))
    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.showTexts', createCommand({ includeFiles: false, includeNodes: false, includeTexts: true })))

    vscode.workspace.onDidChangeConfiguration(() => {
        loadLocalConfiguration()

        fileCache.clear()
        nodeCache.clear()
    })

    function loadLocalConfiguration() {
        const config = vscode.workspace.getConfiguration('codeQuicken')
        filePatterns = config.get<Array<FileConfiguration>>('files', []).map(stub => new FilePattern(stub))
        nodePatterns = config.get<Array<NodeConfiguration>>('nodes', []).map(stub => new NodePattern(stub))
        textPatterns = config.get<Array<TextConfiguration>>('texts', []).map(stub => new TextPattern(stub))
        jsParserPlugins = config.get<Array<string>>('javascript.parser.plugins')
    }

    function createCommand({ includeFiles, includeNodes, includeTexts }) {
        return async function () {
            // Stop processing if the VS Code is not working with folder, or the current document is untitled
            if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
                return null
            }

            const currentDocument = vscode.window.activeTextEditor.document
            const currentFileInfo = new FileInfo(currentDocument.fileName)

            let items: Array<vscode.QuickPickItem> = []

            // Add files which will be shown in VS Code picker
            const applicableFilePatterns = filePatterns.filter(pattern => pattern.check(currentDocument))
            for (let index = 0; index < applicableFilePatterns.length; index++) {
                const fileLinks = await applicableFilePatterns[index].getFileLinks()
                fileLinks.map(fileLink => {
                    if (fileCache.has(fileLink.fsPath) === false) {
                        fileCache.set(fileLink.fsPath, new FileItem(fileLink))
                    }
                    return fileCache.get(fileLink.fsPath)
                }).forEach(item => {
                    item.updateSortablePath(currentFileInfo.directoryPath)

                    if (item.fileInfo.localPath !== currentFileInfo.localPath) {
                        items.push(item)
                    }
                })
            }

            // Remove duplicate files and sort files
            if (items.length > 0) {
                items = _.uniq(items)
                items = _.sortBy(items, [
                    (item: FileItem) => item.sortablePath,
                    (item: FileItem) => item.sortableName,
                ])
            }

            // Add node modules which will be shown in VS Code picker
            if (/^(java|type)script\w*/.test(currentDocument.languageId) && fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
                const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'))

                items = items.concat(_.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
                    .flatten<string>()
                    .map(nodeName => {
                        if (nodeCache.has(nodeName) === false) {
                            const pattern = nodePatterns.find(pattern => pattern.match(nodeName))
                            if (pattern) {
                                nodeCache.set(nodeName, new NodeItem(nodeName))
                            } else {
                                return null
                            }
                        }
                        return nodeCache.get(nodeName)
                    })
                    .compact()
                    .sortBy((item) => item.name)
                    .value()
                )
            }

            items = items.concat(textPatterns
                .filter(pattern => pattern.check(currentDocument))
                .map(pattern => new TextItem(pattern.name))
            )

            // Stop processing if the current editor is not active
            const editor = vscode.window.activeTextEditor
            if (!editor) {
                return null
            }

            // Show VS Code picker and await user for the selection
            const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })

            // Stop processing if there is no selection
            if (!select) {
                return null
            }

            // Read all import/require statements of the current viewing document (JavaScript only)
            const currentCodeTree = Shared.getCodeTree(currentDocument.getText(), currentDocument.languageId, jsParserPlugins)
            let existingImports = []
            if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
                // For `import ...`
                existingImports = existingImports.concat(currentCodeTree.program.body
                    .filter((line: any) => line.type === 'ImportDeclaration' && line.source && line.source.type === 'StringLiteral')
                    .map((line: any) => ({ ...line.loc, name: _.get(_.find(line.specifiers, (spec: any) => spec.type === 'ImportDefaultSpecifier'), 'local.name'), path: line.source.value }))
                )

                // For `var x = require(...)`
                existingImports = existingImports.concat(_.flatten(currentCodeTree.program.body
                    .filter((line: any) => line.type === 'VariableDeclaration')
                    .map((line: any) => line.declarations
                        .filter(stub => _.isMatch(stub, Shared.MODULE_REQUIRE))
                        .map(stub => ({ ...line.loc, name: stub.id.name, path: stub.init.arguments[0].value }))
                    )
                ))

                // For `require(...)`
                existingImports = existingImports.concat(currentCodeTree.program.body
                    .filter((stub: any) => _.isMatch(stub, Shared.MODULE_REQUIRE_IMMEDIATE) && stub.expression.arguments.length === 1)
                    .map((stub: any) => ({ ...stub.loc, path: stub.expression.arguments[0].value }))
                )
            }

            // Create a snippet
            if (select instanceof NodeItem) {
                const pattern = nodePatterns.find(pattern => pattern.match(select.name))

                // Stop processing if the select file does exist in the current viewing document
                if (pattern.checkForImportOrRequire && existingImports.find(stub => stub.path === select.name)) {
                    vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                    return null
                }

                const snippet = pattern.interpolate({
                    _, // Lodash
                    minimatch,
                    path,
                    activeDocument: currentDocument,
                    activeFileInfo: currentFileInfo,
                    moduleName: select.name,
                    moduleVersion: select.version,
                    workspacePath: vscode.workspace.rootPath,
                    ...Shared,
                })

                insertCode(pattern.insertAt, snippet)

            } else if (select instanceof FileItem) {
                const pattern = filePatterns.find(pattern => pattern.match(select.fileInfo.localPath) && pattern.check(currentDocument))

                const selectCodeText = fs.readFileSync(select.fileInfo.localPath, 'utf-8')
                const selectCodeTree = Shared.getCodeTree(selectCodeText, select.fileInfo.fileExtensionWithoutLeadingDot, jsParserPlugins)
                const selectRelativeFilePath = pattern.getRelativeFilePath(select.fileInfo, currentFileInfo.directoryPath)

                const snippet = pattern.interpolate({
                    _, // Lodash
                    minimatch,
                    path,
                    activeDocument: currentDocument,
                    activeFileInfo: currentFileInfo,
                    selectFileInfo: select.fileInfo,
                    selectFilePath: selectRelativeFilePath,
                    selectCodeText: selectCodeText,
                    selectCodeTree: selectCodeTree,
                    selectFileHasDefaultExport: selectCodeTree === null || Shared.findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || Shared.findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS) !== undefined,
                    workspacePath: vscode.workspace.rootPath,
                    isIndexFile: select.fileInfo.fileNameWithoutExtension === 'index' && select.fileInfo.directoryPath !== currentFileInfo.directoryPath,
                    ...Shared,
                })

                if (pattern.checkForImportOrRequire) {
                    if (existingImports.find(stub => stub.value === selectRelativeFilePath)) {
                        vscode.window.showInformationMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                        return null
                    } else {
                        const snippetTree = Shared.getCodeTree(snippet, currentDocument.languageId, jsParserPlugins)
                        const importedVariableName = _.get(snippetTree, 'program.body.0.specifiers.0.local.name', null)
                        const duplicateImport = existingImports.find(stub => stub.name === importedVariableName)
                        if (duplicateImport) {
                            editor.edit(worker => {
                                const range = new vscode.Range(duplicateImport.start.line - 1, duplicateImport.start.column, duplicateImport.end.line - 1, duplicateImport.end.column)
                                worker.replace(range, snippet.trim())
                            })
                            return null
                        }
                    }
                }

                insertCode(pattern.insertAt, snippet)

            } else if (select instanceof TextItem) {
                const pattern = textPatterns.find(pattern => pattern.name === select.label)

                const snippet = pattern.interpolate({
                    _, // Lodash
                    minimatch,
                    path,
                    activeDocument: currentDocument,
                    activeFileInfo: currentFileInfo,
                    workspacePath: vscode.workspace.rootPath,
                    ...Shared,
                })

                // Insert a snippet to the current viewing document
                // Currently does not support tab-stop-and-placeholder, for example `${1:index}`
                editor.insertSnippet(new vscode.SnippetString(snippet))
            }

            function insertCode(insertAt: string, snippet: string) {
                editor.edit(worker => {
                    let position: vscode.Position
                    if (position === undefined) {
                        if (insertAt === 'beforeFirstImport' && existingImports.length > 0) {
                            position = new vscode.Position(_.first(existingImports).start.line - 1, _.first(existingImports).start.column)

                        } else if (insertAt === 'beforeFirstImport' || insertAt === 'top') {
                            position = new vscode.Position(0, 0)

                        } else if (insertAt === 'afterLastImport' && existingImports.length > 0) {
                            position = new vscode.Position(_.last(existingImports).end.line, 0)

                        } else if (insertAt === 'afterLastImport' || insertAt === 'bottom') {
                            position = new vscode.Position(currentDocument.lineCount, 0)

                        } else {
                            position = editor.selection.active
                        }
                    }

                    worker.insert(position, snippet)
                })
            }
        }
    }
}

export function deactivate() {
    fileCache.clear()
    nodeCache.clear()
}
