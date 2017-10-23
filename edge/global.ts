import * as fp from 'path'
import * as _ from 'lodash'
import * as vscode from 'vscode'
import FileInfo from './FileInfo'
import * as JavaScript from './JavaScript'
import * as Stylus from './Stylus'

export interface RootConfigurations {
	history: number
	javascript: JavaScript.LanguageOptions
	stylus: Stylus.LanguageOptions
}

export interface Language {
	getItems(document: vscode.TextDocument): Promise<Array<Item> | null>
	addItem?(filePath: string)
	cutItem?(filePath: string)
	fixImport?(editor: vscode.TextEditor, document: vscode.TextDocument, cancellationToken: vscode.CancellationToken): Promise<boolean | null>
	reset()
}

export interface Item extends vscode.QuickPickItem {
	id: string
	addImport(document: vscode.TextDocument): Promise<(worker: vscode.TextEditorEdit) => void | null | undefined>
}

export function getSortablePath(fileInfo: FileInfo, documentFileInfo: FileInfo) {
	// Set sorting rank according to the directory path
	// a = the opening files in VS Code
	// b = the files that are located in the same directory of the working document
	// cez = "./dir/file"
	// fd = "../file"
	// fez = "../dir/file"
	// ffd = "../../file"
	if (vscode.workspace.textDocuments.find(document => document.fileName === fileInfo.fullPath) !== undefined) {
		return 'a'

	} else if (fileInfo.directoryPath === documentFileInfo.directoryPath) {
		// Set file name similarity level
		// Make similar file name appear on the top of its directory
		const wordsOfDocumentName = _.words(documentFileInfo.fileNameWithExtension)
		const wordsOfThisFileName = _.words(fileInfo.fileNameWithExtension)
		let index = -1
		let bound = wordsOfDocumentName.length
		while (++index < bound) {
			if (wordsOfDocumentName[index] !== wordsOfThisFileName[index]) {
				break
			}
		}
		return 'b' + _.padStart((bound - index).toString(), bound.toString().length, '0')

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
