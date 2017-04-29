import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'

export default class TextPattern {
	private config: TextConfiguration
	readonly interpolate: (object) => string

	get name() {
		return this.config.name
	}

	constructor(config: TextConfiguration) {
		this.config = config

		// Escape `${0:var}` to `$\{0:${var}\}`
		const block = (_.isArray(config.code)
			? config.code.join('\n')
			: config.code
		)
			.split(/\$\{/)
			.map((chunk, order, array) => {
				if (order === 0 || /^\d+:/.test(chunk) === false) {
					return chunk
				}

				let index = chunk.length
				while (--index && index >= 0) {
					if (chunk[index] === '}' && index > 0 && chunk[index - 1] !== '\\') {
						break
					}
				}

				if (index >= 0) {
					const colon = chunk.indexOf(':')
					return '$\\{' + chunk.substring(0, colon) + ':${' + chunk.substring(colon + 1, index).trim() + '}\\}' + chunk.substring(index + 1)
				} else {
					return chunk
				}
			})
			.join('')

		this.interpolate = Shared.createTemplate(block, (text: string) => (
			// Unescape `$\{...\}`
			text.replace(/\$\\\{/g, '${').replace(/\\\}/g, '}')
		))
	}

	check(document: vscode.TextDocument): boolean {
		if (this.config.when) {
			try {
				return Boolean(_.template('${' + this.config.when + '}')({
					_, // Lodash
					minimatch,
					path,
					activeDocument: document,
					activeFileInfo: new FileInfo(document.fileName),
				}))
			} catch (ex) {
				console.error(ex)
				return false
			}
		}
		return true
	}
}
