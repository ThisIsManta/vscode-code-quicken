import * as vscode from 'vscode'
import * as fp from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'
import * as ts from 'typescript'

import { Configuration, Language, Item } from './global';
import FileInfo from './FileInfo'
import JavaScript from './JavaScript'

let fileWatch: vscode.FileSystemWatcher

const languages: Array<Language> = [
    new JavaScript(),
]

export function activate(context: vscode.ExtensionContext) {
    let configuration: Configuration

    function loadLocalConfiguration() {
        configuration = vscode.workspace.getConfiguration().get<Configuration>('codeQuicken')
    }

    loadLocalConfiguration()

    vscode.workspace.onDidChangeConfiguration(() => {
        loadLocalConfiguration()

        languages.forEach(lang => lang.reset())
    })

    fileWatch = vscode.workspace.createFileSystemWatcher('**/*', false, true, false)
    fileWatch.onDidCreate(e => {
        languages.forEach(lang => lang.reset())
    })
    fileWatch.onDidDelete(e => {
        // TODO: remove only the deleted file
        languages.forEach(lang => lang.reset())
    })

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.addImport', async function () {
        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.isUntitled) {
            return null
        }

        const currentDocument = vscode.window.activeTextEditor.document
        const currentFileInfo = new FileInfo(currentDocument.fileName)

        const matchingLanguage = languages.find(lang => lang.support.test(currentDocument.languageId))

        if (!matchingLanguage) {
            return null
        }

        const items = await matchingLanguage.getItems(configuration)

        // Stop processing if the current editor is not active
        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        // Show VS Code picker and await user for the selection
        const selectItem = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Type a file path or node module name' }) as Item

        // Stop processing if there is no selection
        if (!selectItem) {
            return null
        }

        // Insert a snippet
        const delegate = await selectItem.insertImport(currentDocument)
        if (delegate) {
            editor.edit(delegate)
        }
    }))

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
            const codeTree = JavaScript.parse(currentDocument.getText())

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
                    .map((node: any) => new WorkingItem(node.source.value, node.source.loc))
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
    fileWatch.dispose()
    languages.forEach(lang => lang.reset())
}
