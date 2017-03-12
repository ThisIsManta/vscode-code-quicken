import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as _ from 'lodash'
import { match as minimatch } from 'minimatch'
import * as babylon from 'babylon'

const PATH_DELIMITOR_FOR_WINDOWS = /\\/g
const CURRENT_DIRECTORY_SEMANTIC = /^\.\//
const UPPER_DIRECTORY_SEMANTIC = /\.\.\//g
const INDEX_FILE = /^index\.\w+$/i
const EXPORT_DEFAULT = { type: 'ExportDefaultDeclaration' }
const MODULE_EXPORTS = {
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

const fileCache = new Map<string, object>()
const nodeCache = new Map<string, object>()

export function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('haste')
    const filePatterns = config.get('files', []) as Array<{
        path: string | Array<string>,
        code: string | string[],
        when?: string,
        matchPath: (string) => boolean,
        matchCondition: (object) => boolean,
        interpolate: (object) => string,
        omitIndexFile: boolean,
        omitExtensionInFilePath: boolean | string,
        insertAt: string,
        inclusion: Array<string>,
        exclusion: Array<string>,
    }>
    const nodePatterns = config.get('nodes', []) as Array<{
        name: string,
        code: string | string[],
        when?: string,
        matchName: (string) => boolean,
        interpolate: (object) => string,
        insertAt: string,
    }>
    const insertAt = config.get('insertAt') as string
    const parsingPlugins = config.get('javascript.parser.plugins') as Array<string>

    filePatterns.forEach(pattern => {
        const multiPaths = typeof pattern.path === 'string' ? [pattern.path as string] : (pattern.path as Array<string>)
        pattern.inclusion = multiPaths.filter(item => item.startsWith('!') === false)
        pattern.exclusion = _.difference(multiPaths, pattern.inclusion).map(item => _.trimStart(item, '!'))

        pattern.matchPath = (givenPath: string) => {
            const matcher = (glob) => minimatch([givenPath], glob).length > 0
            return pattern.inclusion.some(matcher) && !pattern.exclusion.some(matcher)
        }

        pattern.matchCondition = ({ currentDocument, currentRootPath, currentFilePath, currentFileNameWithoutExtension, currentFileExtension }) => {
            if (pattern.when) {
                try {
                    return Boolean(_.template('${' + pattern.when + '}')({
                        rootPath: currentRootPath.replace(PATH_DELIMITOR_FOR_WINDOWS, '/'),
                        filePath: currentFilePath.replace(PATH_DELIMITOR_FOR_WINDOWS, '/'),
                        fileName: currentFileNameWithoutExtension,
                        fileExtn: currentFileExtension,
                        fileType: currentDocument.languageId,
                    }))
                } catch (ex) {
                    console.error(ex)
                    return false
                }
            }
            return true
        }

        pattern.interpolate = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })
    nodePatterns.forEach(pattern => {
        pattern.matchName = (givenPath: string) => minimatch([givenPath], pattern.name).length > 0

        pattern.interpolate = _.template(_.isArray(pattern.code) ? pattern.code.join('\n') : pattern.code)
    })

    let disposable = vscode.commands.registerCommand('haste', async () => {
        const currentDocument = vscode.window.activeTextEditor.document
        const currentRootPath = vscode.workspace.rootPath
        const currentFilePath = currentDocument.fileName
        const currentFileExtension = path.extname(currentFilePath).replace(/^\./, '')
        const currentFileNameWithoutExtension = path.basename(currentFilePath).replace(new RegExp('\\.' + currentFileExtension + '$', 'i'), '')
        const currentDirectory = path.dirname(currentFilePath)

        let items = []
        const applicableFilePatterns = filePatterns.filter(pattern => pattern.matchCondition({ currentDocument, currentRootPath, currentFilePath, currentFileNameWithoutExtension, currentFileExtension }))
        for (let index = 0; index < applicableFilePatterns.length; index++) {
            const pattern = applicableFilePatterns[index]
            const files = await vscode.workspace.findFiles(
                pattern.inclusion.length === 1 ? pattern.inclusion[0] : ('{' + pattern.inclusion.join(',') + '}'),
                pattern.exclusion.length === 0 ? null : (pattern.exclusion.length === 1 ? pattern.exclusion[0] : ('{' + pattern.exclusion.join(',') + '}')),
                9000
            )
            _.chain(files)
                .map<any>((fileInfo: vscode.Uri) => {
                    if (fileCache.has(fileInfo.fsPath) === false) {
                        // Create a QuickPickItem
                        // See also https://code.visualstudio.com/docs/extensionAPI/vscode-api#_a-namequickpickitemaspan-classcodeitem-id445quickpickitemspan
                        const fileName = path.basename(fileInfo.path)
                        const directoryName = _.last(path.dirname(fileInfo.path).split('/'))
                        fileCache.set(fileInfo.fsPath, {
                            label: pattern.omitIndexFile && INDEX_FILE.test(fileName) && directoryName || fileName,
                            description: _.trim(path.dirname(fileInfo.fsPath.substring(currentRootPath.length)), path.sep),
                            // Additional data
                            type: 'file',
                            path: fileInfo.fsPath,
                            unix: fileInfo.path,
                            dirx: path.dirname(fileInfo.fsPath),
                            iden: INDEX_FILE.test(fileName) ? '!' : fileName.toLowerCase(),
                        })
                    }
                    return fileCache.get(fileInfo.fsPath)
                }).forEach(item => {
                    if (vscode.workspace.textDocuments.find(document => document.fileName === item.path) !== undefined) {
                        item.rank = 'a'
                    } else if (item.dirx === currentDirectory) {
                        item.rank = 'b'
                    } else {
                        item.rank = getRelativePath(item.path, currentDirectory).split('/').map((chunk, index, array) => {
                            if (chunk === '.') return 'c'
                            else if (chunk === '..') return 'f'
                            else if (index === array.length - 1 && index > 0 && array[index - 1] === '..') return 'd'
                            else if (index === array.length - 1) return 'z'
                            return 'e'
                        }).join('')
                    }

                    if (item.path !== currentFilePath) {
                        items.push(item)
                    }
                })
                .value()
        }

        if (items.length > 0) {
            items = _.sortBy(items, 'rank', 'iden')
        }

        if (fs.existsSync(path.join(vscode.workspace.rootPath, 'package.json'))) {
            const packageJson = require(path.join(vscode.workspace.rootPath, 'package.json'))
            _.chain([_.keys(packageJson.devDependencies), _.keys(packageJson.dependencies)])
                .flatten<string>()
                .map<any>(nodeName => {
                    if (nodeCache.has(nodeName) === false) {
                        let nodeVersion = ''
                        try {
                            const packageJson = require(path.join(vscode.workspace.rootPath, 'node_modules', nodeName, 'package.json'))
                            if (packageJson.version) {
                                nodeVersion = packageJson.version
                            }
                        } catch (ex) { }

                        const pattern = nodePatterns.find(pattern => pattern.matchName(nodeName))
                        if (pattern) {
                            nodeCache.set(nodeName, {
                                label: nodeName,
                                description: 'v' + nodeVersion,
                                type: 'node',
                                name: nodeName,
                            })
                        } else {
                            return null
                        }
                    }
                    return nodeCache.get(nodeName)
                })
                .compact()
                .sortBy('name')
                .forEach(item => {
                    items.push(item)
                })
                .value()
        }

        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return null
        }

        const select = await vscode.window.showQuickPick(items, { placeHolder: 'Type a file path or node module name' })
        if (!select) {
            return null
        }

        const currentCodeTree = getCodeTree(currentDocument.getText(), currentDocument.languageId, parsingPlugins)
        let existingImportItems = []
        if (currentCodeTree && currentCodeTree.program && currentCodeTree.program.body) {
            existingImportItems = currentCodeTree.program.body.filter((line: any) => line.type === 'ImportDeclaration' && line.source)
        }

        let code = ''
        let insertAt: string
        if (select.type === 'node') {
            const pattern = nodePatterns.find(pattern => pattern.matchName(select.name))

            insertAt = pattern.insertAt

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === select.name)) {
                vscode.window.showInformationMessage(`The module '${select.name}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                minimatch,
                nodeName: select.name,
                getProperVariableName,
            })

        } else if (select.type === 'file') {
            const selectFileExtension = path.extname(select.path).replace(/^\./, '')
            const selectFileNameWithExtension = path.basename(select.path)
            const selectFileNameWithoutExtension = selectFileNameWithExtension.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            const selectCodeText = fs.readFileSync(select.path, 'utf-8')
            const selectCodeTree = getCodeTree(selectCodeText, selectFileExtension, parsingPlugins)

            const pattern = filePatterns.find(pattern =>
                pattern.matchPath(_.trimStart(select.path.substring(currentRootPath.length).replace(PATH_DELIMITOR_FOR_WINDOWS, '/'), '/')) &&
                pattern.matchCondition({ currentDocument, currentRootPath, currentFilePath, currentFileNameWithoutExtension, currentFileExtension, })
            )

            insertAt = pattern.insertAt

            let selectRelativeFilePath = getRelativePath(select.path, currentDirectory)
            if (pattern.omitIndexFile && INDEX_FILE.test(selectFileNameWithExtension)) {
                selectRelativeFilePath = _.trimEnd(selectRelativeFilePath.substring(0, selectRelativeFilePath.length - selectFileNameWithExtension.length), '/')
            } else if (pattern.omitExtensionInFilePath === true || typeof pattern.omitExtensionInFilePath === 'string' && pattern.omitExtensionInFilePath.toString().length > 0 && new RegExp(pattern.omitExtensionInFilePath, 'i').test(selectFileExtension)) {
                selectRelativeFilePath = selectRelativeFilePath.replace(new RegExp('\\.' + selectFileExtension + '$', 'i'), '')
            }

            if (existingImportItems.find((line: any) => line.source.type === 'StringLiteral' && line.source.value === selectRelativeFilePath)) {
                vscode.window.showErrorMessage(`The file '${selectRelativeFilePath}' has been already imported.`)
                return null
            }

            code = pattern.interpolate({
                _, // Lodash
                minimatch,
                fullPath: select.unix,
                filePath: selectRelativeFilePath,
                fileName: selectFileNameWithoutExtension,
                fileExtn: selectFileExtension,
                getProperVariableName,
                codeText: selectCodeText,
                codeTree: selectCodeTree,
                hasDefaultExport: selectCodeTree === null || findInCodeTree(selectCodeTree, EXPORT_DEFAULT) !== undefined || findInCodeTree(selectCodeTree, MODULE_EXPORTS),
                findInCodeTree: (target) => findInCodeTree(selectCodeTree, target),
            })
        }

        editor.edit(worker => {
            let position: vscode.Position
            if (insertAt === 'beforeFirstImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.first(existingImportItems).loc.start.line - 1, _.first(existingImportItems).loc.start.column)

            } else if (insertAt === 'beforeFirstImport' && existingImportItems.length === 0 || insertAt === 'top') {
                position = new vscode.Position(0, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length > 0) {
                position = new vscode.Position(_.last(existingImportItems).loc.end.line, 0)

            } else if (insertAt === 'afterLastImport' && existingImportItems.length === 0 || insertAt === 'bottom') {
                position = new vscode.Position(currentDocument.lineCount, 0)

            } else {
                position = editor.selection.active
            }

            worker.insert(position, code);
        })
    })

    vscode.workspace.onDidChangeConfiguration(() => {
        vscode.window.showInformationMessage('VS Code must be restarted in order to make changes to Haste extension.')
    })

    context.subscriptions.push(disposable)
}

export function deactivate() {
    fileCache.clear()
    nodeCache.clear()
}

function getRelativePath(givenPath: string, rootPath: string) {
    let relativePath = path.relative(rootPath, givenPath).replace(PATH_DELIMITOR_FOR_WINDOWS, '/')
    if (relativePath.startsWith('../') === false) {
        relativePath = './' + relativePath
    }
    return relativePath
}

function getProperVariableName(fileName: string) {
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

function getCodeTree(text: string, fileExtensionOrLanguageId: string, plugins = []): any {
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

function findInCodeTree(source: object, target: object) {
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
