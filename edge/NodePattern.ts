import * as vscode from 'vscode'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'

export default class NodePattern {
	private config: NodeConfiguration
	readonly interpolate: (object) => string

	get checkForImportOrRequire() {
		return this.config.checkForImportOrRequire
	}

	get insertAt() {
		return this.config.insertAt
	}

	constructor(config: NodeConfiguration) {
		this.config = config

		this.interpolate = Shared.createTemplate(config.code)
	}

	match(moduleName: string): boolean {
		return minimatch([moduleName], this.config.name).length > 0
	}
}
