import * as vscode from 'vscode'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'

export default class NodePattern {
	private config: NodeConfiguration
	readonly interpolate: (object) => string

	get insertAt() {
		return this.config.insertAt
	}

	constructor(config: NodeConfiguration) {
		this.config = config

		this.interpolate = _.template(_.isArray(config.code) ? config.code.join(Shared.getEndOfLine()) : config.code)
	}

	match(moduleName: string): boolean {
		return minimatch([moduleName], this.config.name).length > 0
	}
}
