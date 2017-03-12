import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'

export default class FilePattern {
	path: string | Array<string>
	code: string | string[]
	when?: string
	interpolate: (object) => string
	omitIndexFile: boolean
	omitExtensionInFilePath: boolean | string
	insertAt: string
	private inclusion: Array<string>
	private exclusion: Array<string>

	constructor() {
		const multiPaths = typeof this.path === 'string' ? [this.path as string] : (this.path as Array<string>)
		this.inclusion = multiPaths.filter(item => item.startsWith('!') === false)
		this.exclusion = _.difference(multiPaths, this.inclusion).map(item => _.trimStart(item, '!'))

		this.interpolate = _.template(_.isArray(this.code) ? this.code.join('\n') : this.code)
	}

	get inclusionPath(): string {
		if (this.inclusion.length === 1) {
			return this.inclusion[0]
		} else {
			return '{' + this.inclusion.join(',') + '}'
		}
	}

	get exclusionPath(): string {
		if (this.exclusion.length === 0) {
			return null
		} else if (this.exclusion.length === 1) {
			return this.exclusion[0]
		} else {
			return '{' + this.exclusion.join(',') + '}'
		}
	}

	check(document: vscode.TextDocument): boolean {
		if (this.when) {
			const fileInfo = new FileInfo(document.fileName)
			try {
				return Boolean(_.template('${' + this.when + '}')({
					rootPath: (vscode.workspace.rootPath || '').replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/'),
					filePath: fileInfo.unixPath,
					fileName: fileInfo.fileNameWithoutExtension,
					fileExtn: fileInfo.fileExtensionWithoutLeadingDot,
					fileType: document.languageId,
				}))
			} catch (ex) {
				console.error(ex)
				return false
			}
		}
		return true
	}

	match(givenPath: string): boolean {
		const matcher = (glob) => minimatch([givenPath], glob).length > 0
		return this.inclusion.some(matcher) && !this.exclusion.some(matcher)
	}
}
