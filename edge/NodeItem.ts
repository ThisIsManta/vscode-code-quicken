import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

export default class NodeItem implements vscode.QuickPickItem {
	readonly label: string
	readonly description: string = ''
	readonly name: string
	readonly version: string = ''

	constructor(nodeName: string) {
		this.label = nodeName
		this.name = nodeName

		try {
			const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'))
			if (packageJson.version) {
				this.description = 'v' + packageJson.version
				this.version = packageJson.version
			}
		} catch (ex) { }
	}
}
