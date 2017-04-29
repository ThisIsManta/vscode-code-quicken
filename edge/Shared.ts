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
	type: 'VariableDeclarator',
	init: {
		type: 'CallExpression',
		callee: {
			type: 'Identifier',
			name: 'require'
		},
		arguments: [
			{ type: 'StringLiteral' }
		]
	}
}

export const MODULE_REQUIRE_IMMEDIATE = {
	type: 'ExpressionStatement',
	expression: {
		type: 'CallExpression',
		callee: {
			type: 'Identifier',
			name: 'require'
		}
	}
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

export function createTemplate(code: string | Array<string>, postProcessor?: (string) => string) {
	if (_.isArray(code)) {
		code = code.join('\n')
	} else {
		code = code.replace(/\r\n/g, '\n')
	}
	const template = _.template(code)

	return (context: { activeDocument: vscode.TextDocument }) => {
		const targetIndent = (vscode.window.activeTextEditor.options.insertSpaces as boolean) ? (' '.repeat(vscode.window.activeTextEditor.options.tabSize as number)) : '\t'
		let text = template(context)
			.split('\n')
			.map(line => line.startsWith('\t')
				? line.replace(/^\t/g, originalIndent => targetIndent.repeat(originalIndent.length))
				: line
			)
			.join(context.activeDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')

		if (postProcessor) {
			text = postProcessor(text)
		}

		return text
	}
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
