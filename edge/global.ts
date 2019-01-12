import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import FileInfo from './FileInfo'
import * as JavaScript from './JavaScript'
import * as Stylus from './Stylus'

export interface Configurations {
	history: number
	javascript: JavaScript.LanguageOptions
	typescript: JavaScript.LanguageOptions
	stylus: Stylus.LanguageOptions
}

export interface Language {
	getItems(document: vscode.TextDocument): Promise<Array<Item> | null>
	addItem?(filePath: string): void
	cutItem?(filePath: string): void
	fixImport?(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<boolean | null>
	convertImport?(editor: vscode.TextEditor): Promise<boolean | null>
	reset(): void
}

export interface Item extends vscode.QuickPickItem {
	id: string
	addImport(editor: vscode.TextEditor): Promise<null | undefined>
}

export function getSortablePath(fileInfo: FileInfo, documentFileInfo: FileInfo) {
	// Set sorting rank according to the directory path
	// a   = no longer used
	// bXY = same directory of the active document, where X is the number of the same starting word, and Y is the number of the same appearance word
	// cez = "./subdir/file"
	// fd  = "../file"
	// fez = "../subdir/file"
	// ffd = "../../file"
	if (fileInfo.directoryPath === documentFileInfo.directoryPath) {
		// Calculate file similarity level
		// Note that this makes similar file name appear on the top among the files in the same directory
		const currentActiveFileName = _.words(documentFileInfo.fileNameWithoutExtension)
		const givenComparableFileName = _.words(fileInfo.fileNameWithoutExtension)
		let totalWordCount = currentActiveFileName.length
		let longestStartWordIndex = -1
		while (++longestStartWordIndex < totalWordCount) {
			if (currentActiveFileName[longestStartWordIndex] !== givenComparableFileName[longestStartWordIndex]) {
				break
			}
		}
		const startWordCount = longestStartWordIndex
		const appearanceWordCount = _.intersection(currentActiveFileName, givenComparableFileName).length
		const getSortableCount = (count: number) => _.padStart((totalWordCount - count).toString(), totalWordCount.toString().length, '0')
		return 'b' + getSortableCount(startWordCount) + getSortableCount(appearanceWordCount)

	} else {
		return fileInfo.getRelativePath(documentFileInfo.directoryPath).split('/').map((chunk, index, array) => {
			if (chunk === '.') return 'c'
			else if (chunk === '..') return 'f'
			else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
			else if (index === array.length - 1) return 'z'
			return 'e'
		}).join('')
	}
}

export async function findFilesRoughly(filePath: string, fileExtension?: string) {
	const fileName = fp.basename(filePath)

	let fileLinks = await vscode.workspace.findFiles('**/' + fileName)
	if (fileExtension && fileName.endsWith('.' + fileExtension) === false) {
		fileLinks = fileLinks.concat(await vscode.workspace.findFiles('**/' + fileName + '.' + fileExtension))
		fileLinks = fileLinks.concat(await vscode.workspace.findFiles('**/' + fileName + '/index.' + fileExtension))
	}

	const matchingPaths = fileLinks.map(item => item.fsPath)

	if (matchingPaths.length > 1) {
		// Given originalPath = '../../../abc/xyz.js'
		// Set originalPathList = ['abc', 'xyz.js']
		const originalPathList = filePath.split(/\\|\//).slice(0, -1).filter(pathUnit => pathUnit !== '.' && pathUnit !== '..')

		let count = 0
		while (++count <= originalPathList.length) {
			const refinedPaths = matchingPaths.filter(path => path.split(/\\|\//).slice(0, -1).slice(-count).join('|') === originalPathList.slice(-count).join('|'))
			if (refinedPaths.length === 1) {
				return refinedPaths
			}
		}
	}

	return matchingPaths
}
