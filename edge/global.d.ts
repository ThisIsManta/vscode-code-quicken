import * as vscode from 'vscode'
import * as JavaScript from './JavaScript'

interface Configuration {
	rememberLastSelection: number
	javascript: JavaScript.LanguageOptions
}

interface Language {
	support: RegExp
	getItems(conf: Configuration): Promise<Array<vscode.QuickPickItem>>
	reset()
}

interface Item extends vscode.QuickPickItem {
	insertImport(document: vscode.TextDocument): Promise<(worker: vscode.TextEditorEdit) => void | null | undefined>
}