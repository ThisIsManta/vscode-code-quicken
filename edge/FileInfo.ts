import * as path from 'path'
import * as _ from 'lodash'

import * as Shared from './Shared'

export default class FileInfo {
	readonly localPath: string
	readonly unixPath:string
	readonly fileNameWithExtension:string
	readonly fileNameWithoutExtension:string
	readonly fileExtensionWithoutLeadingDot:string
	readonly directoryPath:string
	readonly directoryName:string

	constructor(localPath: string) {
		this.localPath = localPath
		this.unixPath = this.localPath.replace(Shared.DRIVE_LETTER_FOR_WINDOWS, '/$1/').replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
		this.fileExtensionWithoutLeadingDot = path.extname(this.localPath).replace(/^\./, '')
		this.fileNameWithExtension = path.basename(this.localPath)
		this.fileNameWithoutExtension = this.fileNameWithExtension.replace(new RegExp('\\.' + this.fileExtensionWithoutLeadingDot + '$', 'i'), '')
		this.directoryPath = path.dirname(this.localPath).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
		this.directoryName = _.last(path.dirname(this.localPath).split('/'))
	}

	getRelativePath(rootPath: string) {
		let relativePath = path.relative(rootPath, this.localPath).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
		if (relativePath.startsWith('../') === false) {
			relativePath = './' + relativePath
		}
		return relativePath
	}
}