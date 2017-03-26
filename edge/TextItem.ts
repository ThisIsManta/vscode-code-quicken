import * as vscode from 'vscode'

export default class TextItem implements vscode.QuickPickItem {
	readonly label: string
	readonly description: string = ''

	constructor(name: string) {
		this.label = name
	}
}
