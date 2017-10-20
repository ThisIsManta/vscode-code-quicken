import * as vscode from 'vscode'
import * as JavaScript from './JavaScript'

interface RootConfigurations {
	recentSelectionLimit: number
	javascript: JavaScript.LanguageOptions
}

interface Language {
	getItems(document: vscode.TextDocument): Promise<Array<Item> | null>
	addItem?(filePath: string)
	cutItem?(filePath: string)
	fixImport(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<boolean | null>
	reset()
}

interface Item extends vscode.QuickPickItem {
	id: string
	addImport(document: vscode.TextDocument): Promise<(worker: vscode.TextEditorEdit) => void | null | undefined>
}