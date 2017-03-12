import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import { getProperVariableName, getCodeTree, findInCodeTree } from './Shared'
import FileInfo from './FileInfo'
import FilePattern from './FilePattern'
import NodePattern from './NodePattern'
import FileItem from './FileItem'
import NodeItem from './NodeItem'

const fileCache = new Map<string, FileItem>()
const nodeCache = new Map<string, NodeItem>()

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<FilePattern>
    const nodePatterns = config.get('nodes', []) as Array<NodePattern>
    const insertAt = config.get('insertAt') as string
    const parsingPlugins = config.get('javascript.parser.plugins') as Array<string>

    let disposable = vscode.commands.registerCommand('haste', async () => {
        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
            // TODO: show error message
            return null
        }

        const currentDocument = vscode.window.activeTextEditor.document
        const currentFileInfo = new FileInfo(currentDocument.fileName)

        let items: Array<vscode.QuickPickItem> = []

        const applicableFilePatterns = filePatterns.filter(pattern => (console.log(pattern), pattern.check(currentDocument)))
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index]
            const files = await vscode.workspace.findFiles(pattern.inclusionPath, pattern.exclusionPath, 9000)

            files.map(fileInfo => {
                if (fileCache.has(fileInfo.fsPath) === false) {
                    fileCache.set(fileInfo.fsPath, new FileItem(pattern, fileInfo))
                }
                return fileCache.get(fileInfo.fsPath)
            }).forEach(item => {
                item.updateRank(currentFileInfo.directoryPath)

                if (item.path !== currentFileInfo.localPath) {
                    items.push(item)
                }
            })
        }

        // Remove duplicates and sort files
        if (items.length > 0) {
            items = _.uniq(items)
            items = _.sortBy(items, [
                (item: FileItem) => item.rank,
                (item: FileItem) => item.iden,
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

        const currentCodeTree = getCodeTree(currentDocument.getText(), currentDocument.languageId, parsingPlugins)
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
                getProperVariableName,
            })

        } else if (select instanceof FileItem) {
            const selectFileExtension = path.extname(select.path).replace(/^\./, '')
            const selectFileNameWithExtension = path.basename(select.path)
            const selectFileNameWithoutExtension = selectFileNameWithExtension.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            const selectCodeText = fs.readFileSync(select.path, 'utf-8')
            const selectCodeTree = getCodeTree(selectCodeText, selectFileExtension, parsingPlugins)

            const pattern = filePatterns.find(pattern =>
                pattern.match(_.trimStart(select.path.substring(vscode.workspace.rootPath.length).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'), '/')) &&
                pattern.check(currentDocument)
            )

            insertAt = pattern.insertAt

            let selectRelativeFilePath = FileInfo.getRelativePath(select.path, currentFileInfo.directoryPath)
            if (pattern.omitIndexFile && Shared.INDEX_FILE.test(selectFileNameWithExtension)) {
                selectRelativeFilePath = _.trimEnd(selectRelativeFilePath.substring(0, selectRelativeFilePath.length - selectFileNameWithExtension.length), '/')
            } else if (pattern.omitExtensionInFilePath === true || typeof pattern.omitExtensionInFilePath === 'string' && pattern.omitExtensionInFilePath.toString().length > 0 && new RegExp(pattern.omitExtensionInFilePath, 'i').test(selectFileExtension)) {
                selectRelativeFilePath = selectRelativeFilePath.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            }

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                minimatch,
                fullPath: select.unix,
                filePath: selectRelativeFilePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: selectFileExtension,
                getProperVariableName,
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasDefaultExport: selectCodeTree === null || findInCodeTree(selectCodeTree, Shared.EXPORT_DEFAULT) !== undefined || findInCodeTree(selectCodeTree, Shared.MODULE_EXPORTS),
                findInCodeTree: (target) => findInCodeTree(selectCodeTree, target),
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
