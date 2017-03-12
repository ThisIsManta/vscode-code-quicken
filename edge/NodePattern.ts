import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

export default class NodePattern {
	name: string
	code: string | string[]
	when?: string
	interpolate: (object) => string
	insertAt: string

	constructor() {
		this.interpolate = _.template(_.isArray(this.code) ? this.code.join('\n') : this.code)
	}

	match(givenPath: string): boolean {
		return minimatch([givenPath], this.name).length > 0
	}
}
