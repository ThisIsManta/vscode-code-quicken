import * as vscode from 'vscode'
import * as fp from 'path'
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

let fileCache = new Array<FileItem>()
let fileWatch: vscode.FileSystemWatcher
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

        fileCache = []
        nodeCache.clear()
    })

    function loadLocalConfiguration() {
        const config = vscode.workspace.getConfiguration('codeQuicken')
        filePatterns = config.get<Array<FileConfiguration>>('files', []).map(stub => new FilePattern(stub))
        nodePatterns = config.get<Array<NodeConfiguration>>('nodes', []).map(stub => new NodePattern(stub))
        textPatterns = config.get<Array<TextConfiguration>>('texts', []).map(stub => new TextPattern(stub))
        jsParserPlugins = config.get<Array<string>>('javascript.parser.plugins')
    }

    fileWatch = vscode.workspace.createFileSystemWatcher('**/*', false, true, false)
    fileWatch.onDidCreate(e => {
        fileCache = []
    })
    fileWatch.onDidDelete(e => {
        _.remove(fileCache, fileItem => fileItem.fileInfo.fullPath === e.fsPath)
    })

    function createCommand({ includeFiles, includeNodes, includeTexts }: { includeFiles: boolean, includeNodes: boolean, includeTexts: boolean }) {
        return async function () {
            // Stop processing if the VS Code is not working with folder, or the current document is untitled
            if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
                return null
            }

            const currentDocument = vscode.window.activeTextEditor.document
            const currentFileInfo = new FileInfo(currentDocument.fileName)

            let items: Array<vscode.QuickPickItem> = []

            // Add files which will be shown in VS Code picker
            if (includeFiles) {
                if (fileCache.length > 0) {
                    items = fileCache

                } else {
                    const filePatternsForCurrentDocument = filePatterns.filter(pattern => pattern.check(currentDocument))
                    for (let index = 0; index < filePatternsForCurrentDocument.length; index++) {
                        const fileLinks = await filePatternsForCurrentDocument[index].getFileLinks()
                        items = items.concat(fileLinks.map(fileLink => new FileItem(fileLink)))
                    }

                    fileCache = items as FileItem[]
                }

                items = _.chain(items)
                    .reject((item: FileItem) => item.fileInfo.fullPath === currentFileInfo.fullPath) // Remove the current file
                    .uniq() // Remove duplicate files
                    .forEach((item: FileItem) => item.updateSortablePath(currentFileInfo.directoryPath))
                    .sortBy([ // Sort files by their path and name
                        (item: FileItem) => item.sortablePath,
                        (item: FileItem) => item.sortableName,
                    ])
                    .value()
            }

            // Add node modules which will be shown in VS Code picker
            if (includeNodes) {
                if (/^(java|type)script\w*/.test(currentDocument.languageId) && fs.existsSync(fp.join(vscode.workspace.rootPath, 'package.json'))) {
                    const packageJson = require(fp.join(vscode.workspace.rootPath, 'package.json'))

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
            }

            if (includeTexts) {
                items = items.concat(textPatterns
                    .filter(pattern => pattern.check(currentDocument))
                    .map(pattern => new TextItem(pattern.name))
                )
            }

            // Stop processing if the current editor is not active
            const editor = vscode.window.activeTextEditor
            if (!editor) {
                return null
            }

            // Show VS Code picker and await user for the selection
            const select = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Type a file path or node module name' })

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
                    .map((line: any) => ({ ...line.loc, name: _.get(_.find(line.specifiers, (spec: any) => spec.type === 'ImportDefaultSpecifier'), 'local.name'), path: _.trimEnd(line.source.value, '/') }))
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
                    path: fp,
                    fs,
                    vscode,
                    FileInfo,
                    getMatchingCodeNode: (target) => Shared.findInCodeTree(currentCodeTree, target),
                    activeDocument: currentDocument,
                    activeFileInfo: currentFileInfo,
                    moduleName: select.name,
                    moduleVersion: select.version,
                    workspacePath: vscode.workspace.rootPath,
                    ...Shared,
                })

                insertCode(pattern.insertAt, snippet)

            } else if (select instanceof FileItem) {
                const pattern = filePatterns.find(pattern => pattern.match(select.fileInfo) && pattern.check(currentDocument))

                const selectCodeText = fs.readFileSync(select.fileInfo.fullPath, 'utf-8')
                const selectCodeTree = Shared.getCodeTree(selectCodeText, select.fileInfo.fileExtensionWithoutLeadingDot, jsParserPlugins)
                const selectRelativeFilePath = pattern.getRelativeFilePath(select.fileInfo, currentFileInfo.directoryPath)
                const selectFileHasDefaultExport = selectCodeTree === null || Shared.findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || Shared.findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS) !== undefined
                const isIndexFile = select.fileInfo.fileNameWithoutExtension === 'index' && select.fileInfo.directoryPath !== currentFileInfo.directoryPath

                let selectVariableNameFromIndexFile = ''
                let selectVariableNameFromCurrentFile = ''
                let exportedVariables: Array<string> = []
                if (select.hasIndexFile() && (exportedVariables = select.getExportedVariablesFromIndexFile(jsParserPlugins)).length > 0) {
                    if (exportedVariables.length === 1) {
                        selectVariableNameFromIndexFile = exportedVariables[0]

                    } else if (exportedVariables.length > 1) {
                        selectVariableNameFromIndexFile = await vscode.window.showQuickPick(exportedVariables)
                    }

                } else if (selectFileHasDefaultExport === false) {
                    exportedVariables = select.getExportedVariablesFromCurrentFile(jsParserPlugins)
                    if (exportedVariables.length === 1) {
                        selectVariableNameFromCurrentFile = exportedVariables[0]

                    } else if (exportedVariables.length > 1) {
                        selectVariableNameFromCurrentFile = await vscode.window.showQuickPick(exportedVariables)
                    }
                }

                const snippet = pattern.interpolate({
                    _, // Lodash
                    minimatch,
                    path: fp,
                    fs,
                    vscode,
                    FileInfo,
                    getMatchingCodeNode: (target) => Shared.findInCodeTree(currentCodeTree, target),
                    activeDocument: currentDocument,
                    activeFileInfo: currentFileInfo,
                    selectFileInfo: select.fileInfo,
                    selectFilePath: selectRelativeFilePath,
                    selectCodeText: selectCodeText,
                    selectCodeTree: selectCodeTree,
                    selectFileHasDefaultExport: selectFileHasDefaultExport,
                    selectVariableNameFromCurrentFile: selectVariableNameFromCurrentFile,
                    selectVariableNameFromIndexFile: selectVariableNameFromIndexFile,
                    workspacePath: vscode.workspace.rootPath,
                    isIndexFile: isIndexFile,
                    ...Shared,
                })

                if (pattern.checkForImportOrRequire) {
                    if (existingImports.find(stub => stub.path === selectRelativeFilePath)) {
                        vscode.window.showInformationMessage(`The file '${select.label}' has been already imported.`)
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
                    path: fp,
                    fs,
                    vscode,
                    FileInfo,
                    getMatchingCodeNode: (target) => Shared.findInCodeTree(currentCodeTree, target),
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

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.fixImports', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentFileInfo = new FileInfo(currentDocument.fileName)

        if (_.includes(['javascript', 'javascriptreact', 'typescript', 'typescriptreact'], currentDocument.languageId) === false) {
            vscode.window.showErrorMessage('Code Quicken: The current language was not supported.')
            return null
        }

        let editor = vscode.window.activeTextEditor
        const editorChangeEvent = vscode.window.onDidChangeActiveTextEditor(() => {
            editor = null
        })

        await vscode.window.withProgress({ title: 'Fixing invalid import statements', location: vscode.ProgressLocation.Window }, async () => {
            const codeTree = Shared.getCodeTree(currentDocument.getText(), currentDocument.languageId, jsParserPlugins)

            class WorkingPath implements vscode.QuickPickItem {
                label: string
                description: string
                detail?: string

                completePath: string

                constructor(fullPath: string, origPath: string) {
                    this.completePath = fullPath

                    const fileInfo = new FileInfo(fullPath)
                    const relaPath = fileInfo.getRelativePath(currentFileInfo.directoryPath)
                    const fileName = fp.basename(relaPath)
                    const fileExtn = fp.extname(relaPath)
                    const dirxName = fp.dirname(relaPath).split(/\\|\//).slice(-1)[0]

                    this.description = fullPath.substring(vscode.workspace.rootPath.length).replace(/\\/g, fp.posix.sep)

                    if (fileName === ('index.' + currentFileInfo.fileExtensionWithoutLeadingDot) && origPath.endsWith(dirxName)) {
                        this.label = relaPath.substring(0, relaPath.length - fileName.length - 1)

                    } else if (origPath.endsWith(fileExtn)) {
                        this.label = relaPath

                    } else {
                        this.label = relaPath.substring(0, relaPath.length - fileExtn.length)
                    }
                }
            }

            class WorkingItem {
                originalPath: string
                matchingPath: WorkingPath[] = []
                editableSpan: vscode.Range
                quoteChar: string = '"'

                constructor(path: string, loc: { start: { line: number, column: number }, end: { line: number, column: number } }) {
                    this.originalPath = path
                    this.editableSpan = new vscode.Range(loc.start.line - 1, loc.start.column, loc.end.line - 1, loc.end.column)

                    const originalText = currentDocument.getText(this.editableSpan)
                    if (originalText.startsWith('\'')) {
                        this.quoteChar = '\''
                    }
                }
            }

            const totalImportList = _.flatten([
                _.chain(codeTree.program.body)
                    .filter(node => node.type === 'ImportDeclaration' && node.source.value.startsWith('.') && node.source.value.includes('?') === false && node.source.value.includes('!') === false && node.source.value.includes('"') === false)
                    .map(node => new WorkingItem(node.source.value, node.source.loc))
                    .value(),
                _.chain(findRequireRecursively(codeTree.program.body))
                    .filter(node => node.arguments[0].value.startsWith('.'))
                    .map(node => new WorkingItem(node.arguments[0].value, node.arguments[0].loc))
                    .value(),
            ]).filter(item => item.originalPath)

            const invalidImportList = totalImportList.filter(item =>
                fs.existsSync(fp.join(currentFileInfo.directoryPath, item.originalPath)) === false &&
                fs.existsSync(fp.join(currentFileInfo.directoryPath, item.originalPath + '.' + currentFileInfo.fileExtensionWithoutLeadingDot)) === false
            )

            if (invalidImportList.length === 0) {
                vscode.window.setStatusBarMessage('No broken import/require statements have been found.', 5000)
                return null
            }

            for (const item of invalidImportList) {
                if (!editor) {
                    break
                }

                const sourceFileName = _.last(item.originalPath.split(/\\|\//))
                const matchingImportList = await findFilesRoughly(sourceFileName, currentFileInfo.fileExtensionWithoutLeadingDot)

                item.matchingPath = matchingImportList.map(fullPath => new WorkingPath(fullPath, item.originalPath))

                if (item.matchingPath.length > 1) {
                    // Given originalPath = '../../../abc/xyz.js'
                    // Return originalPathList = ['abc', 'xyz'.js']
                    const originalPathList = item.originalPath.split(/\\|\//).slice(0, -1).filter(pathUnit => pathUnit !== '.' && pathUnit !== '..')

                    let count = 0
                    while (++count <= originalPathList.length) {
                        const refinedList = item.matchingPath.filter(path =>
                            path.completePath.split(/\\|\//).slice(0, -1).slice(-count).join('|') === originalPathList.slice(-count).join('|')
                        )
                        if (refinedList.length === 1) {
                            item.matchingPath = refinedList
                            break
                        }
                    }
                }
            }

            if (!editor) {
                return null
            }

            editor.edit(worker => {
                invalidImportList
                    .filter(item => item.matchingPath.length === 1)
                    .forEach(item => {
                        worker.replace(item.editableSpan, `${item.quoteChar}${item.matchingPath[0].label}${item.quoteChar}`)
                    })
            })

            const unresolvedImportList = invalidImportList.filter(item => item.matchingPath.length !== 1)
            const resolvableImportList = unresolvedImportList.filter(item => item.matchingPath.length > 1)
            if (resolvableImportList.length > 0) {
                for (const item of resolvableImportList) {
                    const selectedPath = await vscode.window.showQuickPick(
                        item.matchingPath,
                        { placeHolder: item.originalPath }
                    )

                    if (!selectedPath) {
                        break
                    }

                    if (!editor) {
                        return null
                    }

                    editor.edit(worker => {
                        worker.replace(item.editableSpan, `${item.quoteChar}${selectedPath.label}${item.quoteChar}`)
                        _.pull(unresolvedImportList, item)
                    })
                }
            }

            if (unresolvedImportList.length === 0) {
                vscode.window.setStatusBarMessage('All broken import/require statements have been fixed.', 5000)

            } else {
                vscode.window.showWarningMessage(`Code Quicken: There ${unresolvedImportList.length === 1 ? 'was' : 'were'} ${unresolvedImportList.length} broken import/require statement${unresolvedImportList.length === 1 ? '' : 's'} that had not been fixed.\n` + unresolvedImportList.map(item => item.originalPath).join('\n'))
            }
        })

        editorChangeEvent.dispose()
    }))
}

async function findFilesRoughly(fileName: string, fileExtn: string) {
    let list = await vscode.workspace.findFiles('**/' + fileName)

    if (fileName.endsWith('.' + fileExtn) === false) {
        list = list.concat(await vscode.workspace.findFiles('**/' + fileName + '.' + fileExtn))
        list = list.concat(await vscode.workspace.findFiles('**/' + fileName + '/index.' + fileExtn))
    }

    return list.map(item => item.fsPath)
}

function findRequireRecursively(node: any, results = [], visited = new Set()) {
    if (visited.has(node)) {
        return results

    } else {
        visited.add(node)
    }

    if (_.isArrayLike(node)) {
        _.forEach(node, stub => {
            findRequireRecursively(stub, results, visited)
        })

    } else if (_.isObject(node) && node.type !== undefined) {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1 && node.arguments[0].type === 'StringLiteral') {
            results.push(node)
            return results
        }

        _.forEach(node, stub => {
            findRequireRecursively(stub, results, visited)
        })
    }

    return results
}

export function deactivate() {
    fileCache = []
    fileWatch.dispose()
    nodeCache.clear()
}
