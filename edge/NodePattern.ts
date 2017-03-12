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

		this.interpolate = _.template(_.isArray(config.code) ? config.code.join('\n') : config.code)
	}

	match(givenPath: string): boolean {
		return minimatch([givenPath], this.config.name).length > 0
	}
}
