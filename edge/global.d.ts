import * as vscode from 'vscode'
import * as JavaScript from './JavaScript'

interface RootConfigurations {
	rememberLastSelection: number
	javascript: JavaScript.LanguageOptions
}

interface Language {
	getItems(document: vscode.TextDocument): Promise<Array<vscode.QuickPickItem> | null>
	addItem?(filePath: string)
	cutItem?(filePath: string)
	fixImport(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<boolean | null>
	reset()
}

interface Item extends vscode.QuickPickItem {
	addImport(document: vscode.TextDocument): Promise<(worker: vscode.TextEditorEdit) => void | null | undefined>
}