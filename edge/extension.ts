import * as vscode from 'vscode'

import { Configurations, Language, Item } from './global';
import LocalStorage from './LocalStorage'
import JavaScript from './JavaScript'
import TypeScript from './TypeScript'
import Stylus from './Stylus'

let languages: Array<Language>
let fileWatch: vscode.FileSystemWatcher
let localStorage = new LocalStorage()

export function activate(context: vscode.ExtensionContext) {
    let config: Configurations

    function initialize() {
        config = vscode.workspace.getConfiguration().get<Configurations>('codeQuicken')

        localStorage.load(config)

        if (languages) {
            languages.forEach(language => language.reset())
        }

        languages = [
            // Add new supported languages here
            new JavaScript(config),
            new TypeScript(config),
            new Stylus(config),
        ]
    }

    initialize()
    vscode.workspace.onDidChangeConfiguration(initialize)

    fileWatch = vscode.workspace.createFileSystemWatcher('**/*', false, true, false)
    fileWatch.onDidCreate(e => {
        languages.forEach(language => language.addItem ? language.addItem(e.fsPath) : language.reset())
    })
    fileWatch.onDidDelete(e => {
        languages.forEach(language => language.cutItem ? language.cutItem(e.fsPath) : language.reset())
    })

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.addImport', async function () {
        const editor = vscode.window.activeTextEditor
        const document = editor && editor.document

        // Stop processing if the VS Code is not working with folder, or the current document is untitled
        if (editor === undefined || document.isUntitled || vscode.workspace.getWorkspaceFolder(document.uri) === undefined) {
            return null
        }

        let progressWillShow = true
        let stopProgress = () => { progressWillShow = false }
        setTimeout(() => {
            if (!progressWillShow) {
                return
            }
            vscode.window.withProgress({ title: 'Populating Files...', location: vscode.ProgressLocation.Window }, async () => {
                await new Promise(resolve => {
                    stopProgress = resolve
                })
            })
        }, 150)

        for (let language of languages) {
            let items = await language.getItems(document)
            if (!items) {
                continue
            }

            // Stop processing if the active editor has been changed
            if (editor !== vscode.window.activeTextEditor) {
                stopProgress()
                return null
            }

            items = localStorage.recentSelectedItems.sort(language, items) as Array<Item>

            stopProgress()

            const selectedItem = await vscode.window.showQuickPick(items, { matchOnDescription: true, placeHolder: 'Type a file path or node module name' })
            if (!selectedItem) {
                return null
            }

            localStorage.recentSelectedItems.markAsRecentlyUsed(language, selectedItem)

            // Insert the snippet
            await selectedItem.addImport(editor)
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('codeQuicken.fixImport', async () => {
        const editor = vscode.window.activeTextEditor
        const document = editor.document

        const cancellationEvent = new vscode.CancellationTokenSource()
        const editorChangeEvent = vscode.window.onDidChangeActiveTextEditor(() => {
            cancellationEvent.cancel()
        })
        const documentCloseEvent = vscode.workspace.onDidCloseTextDocument((closingDocument) => {
            if (document === closingDocument) {
                cancellationEvent.cancel()
            }
        })

        await vscode.window.withProgress({ title: 'Code Quicken: Fixing invalid import/require statements', location: vscode.ProgressLocation.Window }, async () => {
            for (let lang of languages) {
                if (lang.fixImport === undefined) {
                    continue
                }

                const workingDocumentHasBeenFixed = await lang.fixImport(editor, document, cancellationEvent.token)

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
    languages.forEach(language => language.reset())
    fileWatch.dispose()

    localStorage.save()
}
