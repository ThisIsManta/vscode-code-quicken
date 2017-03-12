import * as vscode from 'vscode'
import * as path from 'path'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'

import FileInfo from './FileInfo'
import FilePattern from './FilePattern'

export default class FileItem implements vscode.QuickPickItem {
	label: string
	description: string
	fileInfo: FileInfo
	sortablePath: string
	readonly sortableName: string

	constructor(fileLink: vscode.Uri, pattern: FilePattern) {
		this.fileInfo = new FileInfo(fileLink.fsPath)

		this.label = this.fileInfo.fileNameWithoutExtension === 'index' && this.fileInfo.directoryName || this.fileInfo.fileNameWithExtension
		this.description = _.trim(path.dirname(fileLink.fsPath.substring(vscode.workspace.rootPath.length)), path.sep)

		this.sortableName = this.fileInfo.fileNameWithoutExtension === 'index' ? '!' : this.fileInfo.fileNameWithExtension.toLowerCase()
	}

	updateSortablePath(currentDirectoryPath: string) {
		if (vscode.workspace.textDocuments.find(document => document.fileName === this.fileInfo.localPath) !== undefined) {
			this.sortablePath = 'a'

		} else if (this.fileInfo.directoryPath === currentDirectoryPath) {
			this.sortablePath = 'b'

		} else {
			this.sortablePath = FileInfo.getRelativePath(this.fileInfo.localPath, currentDirectoryPath).split('/').map((chunk, index, array) => {
				if (chunk === '.') return 'c'
				else if (chunk === '..') return 'f'
				else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
				else if (index === array.length - 1) return 'z'
				return 'e'
			}).join('')
		}
	}

	getRelativeFilePath(currentDirectoryPath: string, pattern: FilePattern) {
		let relativeFilePath = FileInfo.getRelativePath(this.fileInfo.localPath, currentDirectoryPath)
		if (pattern.omitIndexFile && this.fileInfo.fileNameWithoutExtension === 'index') {
			relativeFilePath = _.trimEnd(relativeFilePath.substring(0, relativeFilePath.length - this.fileInfo.fileNameWithExtension.length), '/')

		} else if (pattern.omitExtensions && minimatch([this.fileInfo.fileExtensionWithoutLeadingDot], pattern.omitExtensions).length > 0) {
			relativeFilePath = relativeFilePath.substring(0, relativeFilePath.length - 1 - this.fileInfo.fileExtensionWithoutLeadingDot.length)
		}
		return relativeFilePath
	}
}
