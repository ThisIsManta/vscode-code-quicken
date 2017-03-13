import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import * as Shared from './Shared'
import FileInfo from './FileInfo'

export default class FilePattern {
	private config: FileConfiguration
	readonly inclusionList: Array<string>
	readonly exclusionList: Array<string>
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
		this.inclusionList = multiPaths.filter(item => item.startsWith('!') === false)
		this.exclusionList = _.difference(multiPaths, this.inclusionList).map(item => _.trimStart(item, '!'))

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
		return this.inclusionList.some(matcher) && !this.exclusionList.some(matcher)
	}

	getRelativeFilePath(fileInfo: FileInfo, currentDirectoryPath: string) {
		let relativeFilePath = fileInfo.getRelativePath(currentDirectoryPath)
		if (this.config.omitIndexFile && fileInfo.fileNameWithoutExtension === 'index') {
			relativeFilePath = _.trimEnd(relativeFilePath.substring(0, relativeFilePath.length - fileInfo.fileNameWithExtension.length), '/')

		} else if (this.config.omitExtensionInFilePath === true || typeof this.config.omitExtensionInFilePath === 'string' && minimatch([fileInfo.fileExtensionWithoutLeadingDot], this.config.omitExtensionInFilePath).length > 0) {
			relativeFilePath = relativeFilePath.substring(0, relativeFilePath.length - 1 - fileInfo.fileExtensionWithoutLeadingDot.length)
		}
		return relativeFilePath
	}
}
