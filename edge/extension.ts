import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'
import FilePattern from './FilePattern'
import NodePattern from './NodePattern'
import FileItem from './FileItem'
import NodeItem from './NodeItem'

const fileCache = new Map<string, FileItem>()
const nodeCache = new Map<string, NodeItem>()

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get<Array<FileConfiguration>>('files', []).map(stub => new FilePattern(stub))
    const nodePatterns = config.get<Array<NodeConfiguration>>('nodes', []).map(stub => new NodePattern(stub))
    const parserPlugins = config.get('javascript.parser.plugins') as Array<string>

    let disposable = vscode.commands.registerCommand('haste', async () => {
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
            const pattern = applicableFilePatterns[index]

            const inclusionList = pattern.inclusionList
            let inclusionPath
            if (inclusionList.length === 1) {
                inclusionPath = inclusionList[0]
            } else {
                inclusionPath = '{' + inclusionList.join(',') + '}'
            }
            const exclusionList = pattern.exclusionList
            let exclusionPath = null
            if (exclusionList.length === 1) {
                exclusionPath = exclusionList[0]
            } else if (exclusionList.length > 1) {
                exclusionPath = '{' + exclusionList.join(',') + '}'
            }

            const fileList = await vscode.workspace.findFiles(inclusionPath, exclusionPath, 9000)
            fileList.map(fileLink => {
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
        if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
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

        // Read all `import` statements of the current viewing document (JavaScript only)
        const currentCodeTree = Shared.getCodeTree(currentDocument.getText(), currentDocument.languageId, parserPlugins)
        let existingImportStatements = []
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportStatements = currentCodeTree.program.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        // Create a snippet
        let snippet = ''
        let insertAt: string
        if (select instanceof NodeItem) {
            const pattern = nodePatterns.find(pattern => pattern.match(select.name))

            insertAt = pattern.insertAt

            // Stop processing if the select file does exist in the current viewing document
            if (existingImportStatements.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                return null
            }

            snippet = pattern.interpolate({
                _, // Lodash
                minimatch,
                path,
                activeDocument: currentDocument,
                activeFileInfo: currentFileInfo,
                moduleName: select.name,
                moduleVersion: select.version,
                ...Shared,
            })

        } else if (select instanceof FileItem) {
            const selectPathInUnixStyleThatIsRelativeToRootPath = _.trimStart(select.fileInfo.localPath.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/')
            const pattern = filePatterns.find(pattern => pattern.match(selectPathInUnixStyleThatIsRelativeToRootPath) && pattern.check(currentDocument))

            insertAt = pattern.insertAt

            const selectCodeText = fs.readFileSync(select.fileInfo.localPath, 'utf-8')
            const selectCodeTree = Shared.getCodeTree(selectCodeText, select.fileInfo.fileExtensionWithoutLeadingDot, parserPlugins)
            const selectRelativeFilePath = pattern.getRelativeFilePath(select.fileInfo, currentFileInfo.directoryPath)

            if (existingImportStatements.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                return null
            }

            snippet = pattern.interpolate({
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
                ...Shared,
            })
        }

        // Write a snippet to the current viewing document
        editor.edit(worker => {
            let position: vscode.Position
            if (insertAt === 'beforeFirstImport' && existingImportStatements.length > 0) {
                position = new vscode.Position(_.first(existingImportStatements).loc.start.line - 1, _.first(existingImportStatements).loc.start.column)

            } else if (insertAt === 'beforeFirstImport' && existingImportStatements.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0)

            } else if (insertAt === 'afterLastImport' && existingImportStatements.length > 0) {
                position = new vscode.Position(_.last(existingImportStatements).loc.end.line, 0)

            } else if (insertAt === 'afterLastImport' && existingImportStatements.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.lineCount, 0)

            } else {
                position = editor.selection.active
            }

            worker.insert(position, snippet);
        })
    })

    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.')
    })

    context.subscriptions.push(disposable)
}

export function deactivate() {
    fileCache.clear()
    nodeCache.clear()
}
