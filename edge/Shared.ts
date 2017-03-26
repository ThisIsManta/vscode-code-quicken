import * as _ from 'lodash'
import * as babylon from 'babylon'
import * as vscode from 'vscode'

export const PATH_SEPARATOR_FOR_WINDOWS = /\\/g

export const DRIVE_LETTER_FOR_WINDOWS = /^(\w+):\\/

export const CURRENT_DIRECTORY_SEMANTIC = /^\.\//

export const UPPER_DIRECTORY_SEMANTIC = /\.\.\//g

export const INDEX_FILE = /^index\.\w+$/i

export const EXPORT_DEFAULT = { type: 'ExportDefaultDeclaration' }

export const MODULE_EXPORTS = {
	type: 'ExpressionStatement',
	expression: {
		type: 'AssignmentExpression',
		left: {
			type: 'MemberExpression',
			object: { type: 'Identifier', name: 'module' },
			property: { type: 'Identifier', name: 'exports' }
		}
	}
}

export const MODULE_REQUIRE = {
	type:'VariableDeclaration',
	
}

export function getProperVariableName(fileName: string) {
	const words = _.words(fileName)

	let pivot = 0
	let parts = []
	words.forEach(word => {
		const index = fileName.indexOf(word, pivot)
		parts.push((fileName.substring(pivot, index).match(/[_\$]+/g) || []).join(''))
		parts.push(_.upperFirst(word))
	})

	parts = _.compact(parts)

	if (/^\d+/.test(parts[0])) {
		const digit = parts[0].match(/^\d+/)[0]
		parts[0] = parts[0].substring(digit.length)
		parts.push(digit)
	}

	return parts.join('')
}

export function getCodeTree(text: string, fileExtensionOrLanguageId: string, plugins = []): any {
	if (/^(javascript|javascriptreact|js|jsx|typescript|typescriptreact|ts|tsx)$/.test(fileExtensionOrLanguageId) === false) {
		return null
	}
	try {
		return babylon.parse(text, { sourceType: 'module', plugins: [...plugins] })
	} catch (ex) {
		console.error(ex)
		return null
	}
}

export function findInCodeTree(source: object, target: object) {
	if (source === null) {
		return undefined

	} else if (source['type'] === 'File' && source['program']) {
		return findInCodeTree(source['program'], target)

	} else if (_.isMatch(source, target)) {
		return source

	} else if (_.isArrayLike(source['body'])) {
		for (let index = 0; index < source['body'].length; index++) {
			const result = findInCodeTree(source['body'][index], target)
			if (result !== undefined) {
				return result
			}
		}
		return undefined

	} else if (_.isObject(source['body'])) {
		return findInCodeTree(source['body'], target)

	} else {
		return undefined
	}
}

export function getEndOfLine() {
	return vscode.workspace.getConfiguration('files').get<string>('eol')
}
