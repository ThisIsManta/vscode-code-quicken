import * as fp from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as _ from 'lodash'
import { Configurations } from './global'
import RecentSelectedItems from './RecentSelectedItems'

export default class LocalStorage {
	private static path = fp.join(os.tmpdir(), 'vscode.thisismanta.code-quicken.json')

	recentSelectedItems: RecentSelectedItems

	load(config: Configurations) {
		let json = {}
		if (fs.existsSync(LocalStorage.path)) {
			try {
				json = JSON.parse(fs.readFileSync(LocalStorage.path, 'utf-8'))

			} catch (ex) {
				console.error(`Could not read ${LocalStorage.path}.`)
				console.error(ex)
			}
		}

		this.recentSelectedItems = new RecentSelectedItems(config.history)
		this.recentSelectedItems.fromJSON(_.get(json, 'recentSelectedItems', {}))
	}

	save() {
		try {
			fs.writeFileSync(LocalStorage.path, JSON.stringify(this), 'utf-8')

		} catch (ex) {
			console.error(`Could not read ${LocalStorage.path}.`)
			console.error(ex)
		}
	}
}