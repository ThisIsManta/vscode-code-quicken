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
	fixImport(document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<Array<(worker: vscode.TextEditorEdit) => void> | null>
	reset()
}

interface Item extends vscode.QuickPickItem {
	addImport(document: vscode.TextDocument): Promise<(worker: vscode.TextEditorEdit) => void | null | undefined>
}