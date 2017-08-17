import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
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

		if (typeof config.code === 'object') {
			this.interpolate = Shared.createTemplate(config.code)
		} else {
			this.interpolate = Shared.createTemplate(this.config.code, this.escapeTabStops, this.unescapeTabStops)
		}
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

	private escapeTabStops(codeText: string) {
		// Escape `${0:var}` to `$\{0:${var}\}`
		return (codeText)
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
	}

	private unescapeTabStops(codeText: string) {
		// Unescape `$\{...\}`
		return codeText.replace(/\$\\\{/g, '${').replace(/\\\}/g, '}')
	}
}
