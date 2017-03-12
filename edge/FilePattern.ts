import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'

export default class FilePattern {
	private config: FileConfiguration
	private inclusion: Array<string>
	private exclusion: Array<string>
	readonly inclusionPath: string
	readonly exclusionPath: string = null
	readonly omitExtensions: string = null
	readonly interpolate: (object) => string

	get insertAt() {
		return this.config.insertAt
	}

	get omitIndexFile() {
		return this.config.omitIndexFile
	}

	constructor(config: FileConfiguration) {
		this.config = config

		const multiPaths = typeof config.path === 'string' ? [config.path as string] : (config.path as Array<string>)
		this.inclusion = multiPaths.filter(item => item.startsWith('!') === false)
		this.exclusion = _.difference(multiPaths, this.inclusion).map(item => _.trimStart(item, '!'))
		if (this.inclusion.length === 1) {
			this.inclusionPath = this.inclusion[0]
		} else {
			this.inclusionPath = '{' + this.inclusion.join(',') + '}'
		}
		if (this.exclusion.length === 1) {
			this.exclusionPath = this.exclusion[0]
		} else if (this.exclusion.length > 1) {
			this.exclusionPath = '{' + this.exclusion.join(',') + '}'
		}

		if (config.omitExtensionInFilePath === true) {
			this.omitExtensions = '*'
		} else if (typeof config.omitExtensionInFilePath === 'string') {
			this.omitExtensions = config.omitExtensionInFilePath
		}

		this.interpolate = _.template(_.isArray(config.code) ? config.code.join('\n') : config.code)
	}

	check(document: vscode.TextDocument): boolean {
		if (this.config.when) {
			const fileInfo = new FileInfo(document.fileName)
			try {
				return Boolean(_.template('${' + this.config.when + '}')({
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
