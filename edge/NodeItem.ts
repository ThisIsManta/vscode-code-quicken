import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

export default class NodeItem implements vscode.QuickPickItem {
	label: string
	description: string = ''
	readonly name: string

	constructor(nodeName: string) {
		this.label = nodeName
		this.name = nodeName

		try {
			const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'))
			if (packageJson.version) {
				this.description = packageJson.version
			}
		} catch (ex) { }
	}
}
