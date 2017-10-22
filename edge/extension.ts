import * as fp from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as _ from 'lodash'
import * as vscode from 'vscode'

import { RootConfigurations, Language, Item } from './global';
import LocalStorage from './LocalStorage'
import RecentSelectedItems from './RecentSelectedItems'
import JavaScript from './JavaScript'
import Stylus from './Stylus'

let languages: Array<Language>
let fileWatch: vscode.FileSystemWatcher
let localStorage = new LocalStorage()

export function activate(context: vscode.ExtensionContext) {
    let rootConfig: RootConfigurations

    function initialize() {
        rootConfig = vscode.workspace.getConfiguration().get<RootConfigurations>('codeQuicken')

        localStorage.load(rootConfig)

        if (languages) {
            languages.forEach(lang => lang.reset())
        }

        languages = [
            // Add new supported languages here
            new JavaScript(rootConfig),
            new Stylus(rootConfig),
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

                items = localStorage.recentSelectedItems.sort(lang, items)

                // Show VS Code picker
                const selectedItem = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Type a file path or node module name' }) as Item

                // Stop processing if the user does not select anything
                if (!selectedItem) {
                    return null
                }

                localStorage.recentSelectedItems.markAsRecentlyUsed(lang, selectedItem)

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

        await vscode.window.withProgress({ title: 'Code Quicken: Fixing invalid import/require statements', location: vscode.ProgressLocation.Window }, async () => {
            for (let lang of languages) {
                if (lang.fixImport === undefined) {
                    continue
                }

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

    localStorage.save()
}
