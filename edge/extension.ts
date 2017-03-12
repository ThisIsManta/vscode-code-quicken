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
    const filePatterns = config.get<Array<FilePattern>>('files', [])
    const nodePatterns = config.get('nodes', []) as Array<NodePattern>
    const parserPlugins = config.get('javascript.parser.plugins') as Array<string>

    let disposable = vscode.commands.registerCommand('haste', async () => {
        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
            // TODO: show error message
            return null
        }

        const currentDocument = vscode.window.activeTextEditor.document
        const currentFileInfo = new FileInfo(currentDocument.fileName)

        let items: Array<vscode.QuickPickItem> = []

        // Add files
        const applicableFilePatterns = filePatterns.filter(pattern => (console.log(pattern), pattern.check(currentDocument)))
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index]
            const files = await vscode.workspace.findFiles(pattern.inclusionPath, pattern.exclusionPath, 9000)

            files.map(fileLink => {
                if (fileCache.has(fileLink.fsPath) === false) {
                    fileCache.set(fileLink.fsPath, new FileItem(fileLink, pattern))
                }
                return fileCache.get(fileLink.fsPath)
            }).forEach(item => {
                item.updateSortablePath(currentFileInfo.directoryPath)

                if (item.fileInfo.localPath !== currentFileInfo.localPath) {
                    items.push(item)
                }
            })
        }

        // Remove duplicates and sort files
        if (items.length > 0) {
            items = _.uniq(items)
            items = _.sortBy(items, [
                (item: FileItem) => item.sortablePath,
                (item: FileItem) => item.sortableName,
            ])
        }

        // Add node modules
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

        // Stop processing if there is no selection
        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        const currentCodeTree = Shared.getCodeTree(currentDocument.getText(), currentDocument.languageId, parserPlugins)
        let existingImportItems = []
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportItems = currentCodeTree.program.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        let code = ''
        let insertAt: string
        if (select instanceof NodeItem) {
            const pattern = nodePatterns.find(pattern => pattern.match(select.name))

            insertAt = pattern.insertAt

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                minimatch,
                nodeName: select.name,
                ...Shared,
            })

        } else if (select instanceof FileItem) {
            const pattern = filePatterns.find(pattern =>
                pattern.match(_.trimStart(select.fileInfo.localPath.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/')) &&
                pattern.check(currentDocument)
            ) as FilePattern

            insertAt = pattern.insertAt

            const selectCodeText = fs.readFileSync(select.fileInfo.localPath, 'utf-8')
            const selectCodeTree = Shared.getCodeTree(selectCodeText, select.fileInfo.fileExtensionWithoutLeadingDot, parserPlugins)
            const selectRelativeFilePath = select.getRelativeFilePath(currentFileInfo.directoryPath, pattern)

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                minimatch,
                fullPath: select.fileInfo.unixPath,
                filePath: selectRelativeFilePath,
                fileName: select.fileInfo.fileNameWithoutExtension,
                fileExtn: select.fileInfo.fileNameWithExtension,
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasDefaultExport: selectCodeTree === null || Shared.findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || Shared.findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS),
                ...Shared,
                findInCodeTree: (target) => Shared.findInCodeTree(selectCodeTree, target),
            })
        }

        editor.edit(worker => {
            let position: vscode.Position
            if (insertAt === 'beforeFirstImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column)

            } else if (insertAt === 'beforeFirstImport' && existingImportItems.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.lineCount, 0)

            } else {
                position = editor.selection.active
            }

            worker.insert(position, code);
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
