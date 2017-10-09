import * as _ from 'lodash'
import * as babylon from 'babylon'
import * as vscode from 'vscode'
import * as fp from 'path'
import * as glob from 'glob'
import FileInfo from './FileInfo'

export const PATH_SEPARATOR_FOR_WINDOWS = /\\/g

export const DRIVE_LETTER_FOR_WINDOWS = /^(\w+):(\\|\/)/

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

	let parts = []
	words.forEach((word, rank) => {
		const index = fileName.indexOf(word)
		parts.push((fileName.substring(0, index).match(/[_\$]+/g) || []).join(''))
		parts.push(rank === 0 ? word : _.upperFirst(word))
	})

	parts = _.compact(parts)

	if (/^\d+/.test(parts[0])) {
		const digit = parts[0].match(/^\d+/)[0]
		parts[0] = parts[0].substring(digit.length)
		parts.push(digit)
	}

	return parts.join('')
}

export function createTemplate(code: string | Array<string> | { fromFile: string }, foreProcessor?: (string) => string, postProcessor?: (string) => string) {
	if (typeof code === 'object') {
		const codePath = _.get(code, 'fromFile')
		return (context: { activeDocument: vscode.TextDocument }) => {
			const codeFunc = require(fp.resolve(vscode.workspace.rootPath, codePath))
			return normalize(codeFunc(context), context.activeDocument)
		}

	} else {
		if (_.isArray(code)) {
			code = code.join('\n')
		} else {
			code = code.replace(/\r\n/g, '\n')
		}

		if (typeof foreProcessor === 'function') {
			code = foreProcessor(code)
		}

		let template
		try {
			template = _.template(code)
		} catch (ex) {
			throw new Error('Error parsing: ' + code + '\n' + ex.message)
		}

		return (context: { activeDocument: vscode.TextDocument }) => {
			let text = normalize(template(context), context.activeDocument)
			if (typeof postProcessor === 'function') {
				text = postProcessor(text)
			}
			return text
		}
	}
}

function normalize(text: string, activeDocument: vscode.TextDocument) {
	const targetIndent = (vscode.window.activeTextEditor.options.insertSpaces as boolean) ? (' '.repeat(vscode.window.activeTextEditor.options.tabSize as number)) : '\t'
	return text
		.split(/\r?\n/)
		.map(line => line.startsWith('\t')
			? line.replace(/^\t/g, originalIndent => targetIndent.repeat(originalIndent.length))
			: line
		)
		.join(activeDocument.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')
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

	} else if (_.get(source, 'type', '').endsWith('Declaration') && _.has(source, 'declaration')) {
		return findInCodeTree(source['declaration'], target)

	} else if (_.get(source, 'type', '').endsWith('Declaration') && _.has(source, 'declarations') && _.isArray(source['declarations'])) {
		for (let index = 0; index < source['declarations'].length; index++) {
			const result = findInCodeTree(source['declarations'][index], target)
			if (result !== undefined) {
				return result
			}
		}
		return undefined

	} else {
		return undefined
	}
}

export function getFilePath(pattern: string) {
	return glob
		.sync(pattern, { cwd: fp.dirname(vscode.window.activeTextEditor.document.fileName), root: vscode.workspace.rootPath })
		.map(path => new FileInfo(path))
}
