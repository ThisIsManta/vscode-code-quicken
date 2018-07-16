import * as fs from 'fs'
import * as fp from 'path'
import * as _ from 'lodash'

const PATH_SEPARATOR_FOR_WINDOWS = /\\/g

const DRIVE_LETTER_FOR_WINDOWS = /^(\w+):(\\|\/)/

const CURRENT_DIRECTORY_SEMANTIC = /^\.\//

const UPPER_DIRECTORY_SEMANTIC = /\.\.\//g

export default class FileInfo {
	readonly fullPath: string
	readonly fullPathForPOSIX: string
	readonly fileNameWithExtension: string
	readonly fileNameWithoutExtension: string
	readonly fileExtensionWithoutLeadingDot: string
	readonly directoryName: string
	readonly directoryPath: string
	readonly directoryPathForPOSIX: string

	constructor(fullPath: string) {
		// Correct invalid path usually from "glob"
		if (DRIVE_LETTER_FOR_WINDOWS.test(fullPath) && fullPath.includes(fp.posix.sep)) {
			fullPath = fullPath.replace(new RegExp('\\' + fp.posix.sep, 'g'), fp.win32.sep)
		}

		this.fullPath = fullPath
		this.fullPathForPOSIX = this.fullPath.replace(DRIVE_LETTER_FOR_WINDOWS, '/$1/').replace(PATH_SEPARATOR_FOR_WINDOWS, '/')
		this.fileExtensionWithoutLeadingDot = fp.extname(this.fullPath).replace(/^\./, '')
		this.fileNameWithExtension = fp.basename(this.fullPath)
		this.fileNameWithoutExtension = this.fileNameWithExtension.replace(new RegExp('\\.' + this.fileExtensionWithoutLeadingDot + '$', 'i'), '')
		this.directoryName = _.last(fp.dirname(this.fullPath).split(fp.sep))
		this.directoryPath = fp.dirname(this.fullPath)
		this.directoryPathForPOSIX = fp.dirname(this.fullPath).replace(DRIVE_LETTER_FOR_WINDOWS, '/$1/').replace(PATH_SEPARATOR_FOR_WINDOWS, '/')
	}

	getRelativePath(directoryPath: string) {
		let relativePath = fp.relative(directoryPath, this.fullPath).replace(PATH_SEPARATOR_FOR_WINDOWS, '/')
		if (relativePath.startsWith('../') === false) {
			relativePath = './' + relativePath
		}
		return relativePath
	}

	static resolve(...path: string[]) {
		let filePath = fp.resolve(...path)
		let fileList: Array<string>

		if (fs.existsSync(filePath)) {
			let fileStat = fs.lstatSync(filePath)
			if (fileStat.isFile()) {
				fileList = [filePath]

			} else if (fileStat.isDirectory()) {
				fileList = fs.readdirSync(filePath)
					.map(path => fp.join(filePath, path))
			}

		} else {
			const fileName = new RegExp('/' + _.escapeRegExp(fp.basename(filePath) + '\\.\\w+'))
			let dirxPath = fp.dirname(filePath)
			fileList = fs.readdirSync(dirxPath)
				.map(path => fp.join(dirxPath, path))
				.filter(path => fileName.test(fp.basename(path)))
		}

		return fileList.map(path => new FileInfo(path))
	}
}