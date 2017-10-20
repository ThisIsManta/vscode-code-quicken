import * as fp from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import * as vscode from 'vscode'

import { RootConfigurations, Language, Item } from './global';
import FileInfo from './FileInfo'
import JavaScript from './JavaScript'

let languages: Array<Language>
let fileWatch: vscode.FileSystemWatcher
let recentSelectedItems: Map<Language, Array<string>>

export function activate(context: vscode.ExtensionContext) {
    let rootConfig: RootConfigurations

    function initialize() {
        rootConfig = vscode.workspace.getConfiguration().get<RootConfigurations>('codeQuicken')

        // TODO: load from temp
        recentSelectedItems = new Map<Language, Array<string>>()

        if (languages) {
            languages.forEach(lang => lang.reset())
        }

        languages = [
            // Add new supported languages here
            new JavaScript(rootConfig),
        ]
    }

    initialize()
    vscode.workspace.onDidChangeConfiguration(initialize)

    fileWatch = vscode.workspace.createFileSystemWatcher('**/*', false, true, false)
    fileWatch.onDidCreate(e => {
        languages.forEach(lang => lang.addItem ? lang.addItem(e.fsPath) : lang.reset())
    })
    fileWatch.onDidDelete(e => {
        languages.forEach(lang => lang.cutItem ? lang.cutItem(e.fsPath) : lang.reset())
    })

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.addImport', async function () {
        const workingEditor = vscode.window.activeTextEditor
        const workingDocument = workingEditor && workingEditor.document

        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (vscode.workspace.rootPath === undefined || workingEditor === undefined || workingDocument.isUntitled) {
            return null
        }

        for (let lang of languages) {
            let items = await lang.getItems(workingDocument)
            if (items !== null) {
                // Stop processing if the active editor has been changed
                if (workingEditor !== vscode.window.activeTextEditor) {
                    return null
                }

                if (recentSelectedItems.has(lang)) {
                    const recentSelectedItemIds = recentSelectedItems.get(lang)
                    items = _.sortBy(items, item => {
                        const rank = recentSelectedItemIds.indexOf(item.id)
                        return rank === -1 ? Infinity : rank
                    })
                }

                // Show VS Code picker
                const selectedItem = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Type a file path or node module name' }) as Item

                // Stop processing if the user does not select anything
                if (!selectedItem) {
                    return null
                }

                if (selectedItem.id) {
                    if (recentSelectedItems.has(lang)) {
                        const recentSelectedItemIds = recentSelectedItems.get(lang)
                        if (recentSelectedItemIds.indexOf(selectedItem.id) >= 0) {
                            recentSelectedItemIds.splice(recentSelectedItemIds.indexOf(selectedItem.id), 1)
                        }
                        recentSelectedItemIds.unshift(selectedItem.id)
                        if (recentSelectedItemIds.length > rootConfig.recentSelectionLimit) {
                            recentSelectedItemIds.pop()
                        }

                    } else {
                        recentSelectedItems.set(lang, [selectedItem.id])
                    }
                }

                // Insert the snippet
                const action = await selectedItem.addImport(workingDocument)
                if (action) {
                    workingEditor.edit(action)
                }

                break
            }
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.fixImport', async () => {
        const workingEditor = vscode.window.activeTextEditor
        const workingDocument = workingEditor.document

        const cancellationEvent = new vscode.CancellationTokenSource()
        const editorChangeEvent = vscode.window.onDidChangeActiveTextEditor(() => {
            cancellationEvent.cancel()
        })
        const documentCloseEvent = vscode.workspace.onDidCloseTextDocument((closingDocument) => {
            if (workingDocument === closingDocument) {
                cancellationEvent.cancel()
            }
        })

        await vscode.window.withProgress({ title: 'Fixing invalid import/require statements', location: vscode.ProgressLocation.Window }, async () => {
            for (let lang of languages) {
                const workingDocumentHasBeenFixed = await lang.fixImport(workingEditor, workingDocument, cancellationEvent.token)

                // Stop processing if it is handled or cancelled
                if (workingDocumentHasBeenFixed === true || workingDocumentHasBeenFixed === null) {
                    return null
                }
            }

            // Show the error message if no languages can fix the imports
            vscode.window.showErrorMessage('Code Quicken: The current language was not supported.')
        })

        editorChangeEvent.dispose()
        documentCloseEvent.dispose()
        cancellationEvent.dispose()
    }))
}

export function deactivate() {
    languages.forEach(lang => lang.reset())
    fileWatch.dispose()

    // TODO: save to temp
    recentSelectedItems.clear()
}
