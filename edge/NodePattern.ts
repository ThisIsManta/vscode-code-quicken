import * as vscode from 'vscode'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

export default class NodePattern {
	private config: NodeConfiguration
	readonly interpolate: (object) => string

	get insertAt() {
		return this.config.insertAt
	}

	constructor(config: NodeConfiguration) {
		this.config = config

		const endOfLine = vscode.workspace.getConfiguration('files').get<string>('eol')
		this.interpolate = _.template(_.isArray(config.code) ? config.code.join(endOfLine) : config.code)
	}

	match(givenPath: string): boolean {
		return minimatch([givenPath], this.config.name).length > 0
	}
}
