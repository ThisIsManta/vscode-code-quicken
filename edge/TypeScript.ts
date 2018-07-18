import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import { RootConfigurations } from './global'
import JavaScript from './JavaScript'

export default class TypeScript extends JavaScript {
	constructor(baseConfig: RootConfigurations) {
		super(baseConfig)

		this.acceptedLanguage = /^typescript(react)?/
	}

	getLanguageOptions() {
		return this.baseConfig.typescript
	}

	async checkIfImportDefaultIsPreferredOverNamespace() {
		const tsConfig = await this.getTypeScriptConfigurations()
		return _.get<boolean>(tsConfig, 'compilerOptions.esModuleInterop', false)
	}

	protected async createFileFilter() {
		const tsConfig = await this.getTypeScriptConfigurations()
		if (_.get<boolean>(tsConfig, 'compilerOptions.allowJs', false)) {
			return (link: vscode.Uri) => true
		} else {
			// Reject JS files
			const JAVASCRIPT_EXTENSION = /\.jsx?$/i
			return (link: vscode.Uri) => !JAVASCRIPT_EXTENSION.test(link.fsPath)
		}
	}

	private async getTypeScriptConfigurations() {
		const pathList = await vscode.workspace.findFiles('**/tsconfig.json')
		const path = _.chain(pathList)
			.map(link => link.fsPath)
			.sortBy(path => -fp.dirname(path).split(fp.sep).length)
			.find(path => vscode.window.activeTextEditor.document.uri.fsPath.startsWith(fp.dirname(path) + fp.sep))
			.value()
		if (path) {
			return JSON.parse(fs.readFileSync(path, 'utf-8'))
		}
	}
}