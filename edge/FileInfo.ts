import * as path from 'path'
import * as _ from 'lodash'

import * as Shared from './Shared'

export default class FileInfo {
	readonly fullPath: string
	readonly fullPathForPOSIX:string
	readonly fileNameWithExtension:string
	readonly fileNameWithoutExtension:string
	readonly fileExtensionWithoutLeadingDot:string
	readonly directoryName:string
	readonly directoryPath:string
	readonly directoryPathForPOSIX:string

	constructor(fullPath: string) {
		// Correct invalid path usually from "glob"
		if (Shared.DRIVE_LETTER_FOR_WINDOWS.test(fullPath) && fullPath.includes(path.posix.sep)) {
			fullPath = fullPath.replace(new RegExp('\\' + path.posix.sep, 'g'), path.win32.sep)
		}

		this.fullPath = fullPath
		this.fullPathForPOSIX = this.fullPath.replace(Shared.DRIVE_LETTER_FOR_WINDOWS, '/$1/').replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
		this.fileExtensionWithoutLeadingDot = path.extname(this.fullPath).replace(/^\./, '')
		this.fileNameWithExtension = path.basename(this.fullPath)
		this.fileNameWithoutExtension = this.fileNameWithExtension.replace(new RegExp('\\.' + this.fileExtensionWithoutLeadingDot + '$', 'i'), '')
		this.directoryName = _.last(path.dirname(this.fullPath).split(path.sep))
		this.directoryPath = path.dirname(this.fullPath)
		this.directoryPathForPOSIX = path.dirname(this.fullPath).replace(Shared.DRIVE_LETTER_FOR_WINDOWS, '/$1/').replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
	}

	getRelativePath(directoryPath: string) {
		let relativePath = path.relative(directoryPath, this.fullPath).replace(Shared.PATH_SEPARATOR_FOR_WINDOWS, '/')
		if (relativePath.startsWith('../') === false) {
			relativePath = './' + relativePath
		}
		return relativePath
	}
}