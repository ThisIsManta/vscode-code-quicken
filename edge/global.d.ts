interface FileConfiguration {
	path: string | Array<string>
	code: string | string[]
	when?: string
	checkForImportOrRequire: boolean,
	interpolate: (object) => string
	omitIndexInSelectFilePath: boolean
	omitExtensionInSelectFilePath: boolean | string
	insertAt: string
}

interface NodeConfiguration {
	name: string
	code: string | string[]
	when?: string
	checkForImportOrRequire: boolean,
	insertAt: string
}

interface TextConfiguration {
	name: string
	code: string | string[]
	when?: string
}
