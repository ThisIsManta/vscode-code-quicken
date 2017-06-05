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
		const block = (_.isArray(config.code) ? config.code.join('\n') : config.code)
			.split(/\$\{/)
			.map((chunk, order, array) => {
				if (order === 0) {
					return chunk
				} else if (/^\d+:/.test(chunk) === false) {
					return '${' + chunk
				}

				let closingBraceIndex = -1
				let bracePairCount = 0
				while (++closingBraceIndex < chunk.length) {
					if (closingBraceIndex > 0 && chunk[closingBraceIndex - 1] !== '\\') {
						if (chunk[closingBraceIndex] === '{') {
							bracePairCount += 1
						} else if (chunk[closingBraceIndex] === '}') {
							if (bracePairCount === 0) {
								break
							} else {
								bracePairCount -= 1
							}
						}
					}
				}

				if (closingBraceIndex >= 0 && closingBraceIndex < chunk.length) {
					const colon = chunk.indexOf(':')
					return '$\\{' + chunk.substring(0, colon) + ':${' + chunk.substring(colon + 1, closingBraceIndex).trim() + '}\\}' + chunk.substring(closingBraceIndex + 1)
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
				const result = (_.template('${' + this.config.when + '}')({
					_, // Lodash
					minimatch,
					path,
					activeDocument: document,
					activeFileInfo: new FileInfo(document.fileName),
				}))
				return !(result === 'false' || result === '' || parseFloat(result) === 0)
			} catch (ex) {
				console.error(ex)
				return false
			}
		}
		return true
	}
}
