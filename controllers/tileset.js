const fs = require('fs')
const path = require('path')
const url = require('url')
const _ = require('lodash')
const async = require('async')
const mkdirp = require('mkdirp')
const mapboxFileSniff = require('@mapbox/mapbox-file-sniff')
const shapefileFairy = require('@mapbox/shapefile-fairy')
const tilelive = require('@mapbox/tilelive')
const mbtiles = require('mbtiles')
const tileliveOmnivore = require('@mapbox/tilelive-omnivore')
const Tileset = require('../models/tileset')

mbtiles.registerProtocols(tilelive)
tileliveOmnivore.registerProtocols(tilelive)


module.exports.list = function(req, res, next) {
  const owner = req.params.owner

  Tileset.find({owner}, (err, tilesets) => {
    if (err) return next(err)

    res.json(tilesets)
  })
}


module.exports.get = function(req, res, next) {
  const owner = req.params.owner
  const tilesetId = req.params.tilesetId
  const tilesetPath = path.join('tilesets', owner, tilesetId)

  Tileset.findOne({owner, tilesetId}, (err, tileset) => {
    if (err) return next(err)
    if (!tileset) return res.sendStatus(404)

    const source = 'mbtiles://' + path.resolve(tilesetPath)
    tilelive.info(source, (err, info) => {
      if (err) return next(err)

      const urlObject = url.parse(req.originalUrl)
      urlObject.protocol = req.protocol
      urlObject.host = req.get('host')
      urlObject.path = urlObject.pathname + '/{z}/{x}/{y}.' + info.format
      info.tiles = [url.format(urlObject)]
      info.scheme = 'xyz'
      res.json(Object.assign(info, tileset.toJSON()))
    })
  })
}


module.exports.create = function(req, res, next) {
  const owner = req.params.owner
  const tilesetId = req.params.tilesetId
  const filePath = path.resolve(req.files[0].path)
  const originalname = req.files[0].originalname

  async.autoInject({
    tileset: callback => {
      if (!tilesetId) {
        const tileset = new Tileset({owner})
        return tileset.save((err, tileset) => callback(err, tileset))
      }

      Tileset.findOne({owner, tilesetId}, (err, tileset) => {
        if (err) return callback(err)
        if (!tileset) return callback({status: 404})

        callback(null, tileset)
      })
    },

    fileinfo: callback => {
      mapboxFileSniff.fromFile(filePath, callback)
    },

    source: (fileinfo, callback) => {
      if (fileinfo.protocol !== 'omnivore:' && fileinfo.protocol !== 'mbtiles:') {
        return callback({status: 400, message: 'Unsupport file format.'})
      }

      if (fileinfo.type === 'zip') {
        return shapefileFairy(filePath, (err, path) => {
          callback(err, fileinfo.protocol + '//' + path)
        })
      }

      callback(null, fileinfo.protocol + '//' + filePath)
    },

    info: (source, callback) => {
      tilelive.info(source, callback)
    },

    writeDB: (tileset, info, callback) => {
      tileset.name = tileset.name || info.name || path.basename(originalname, path.extname(originalname))
      tileset.description = tileset.description || info.description
      tileset.complete = false
      tileset.progress = 0
      tileset.err = undefined
      tileset.save((err, tileset) => callback(err, tileset))
    }
  }, (err, results) => {
    if (err) return next(err)

    res.json(results.writeDB)

    // Import Tiles
    const tileset = results.writeDB
    const source = results.source

    const tilesetDir = path.join('tilesets', owner)
    mkdirp(tilesetDir, err => {
      if (err) return tileset.save()

      const dest = `mbtiles://${path.resolve(tilesetDir)}/${tileset.tilesetId}`
      const options = {
        retry: 2,
        timeout: 120000,
        close: true,
        progress: _.throttle((stats, p) => {
          tileset.update({progress: Math.round(p.percentage)})
        })
      }

      tilelive.copy(source, dest, options, err => {
        tileset.update({complete: true, error: err})
        fs.unlink(filePath)
      })
    })
  })
}


module.exports.update = function(req, res, next) {
  const owner = req.params.owner
  const tilesetId = req.params.tilesetId
  const update = _.pick(req.body, ['name', 'description'])

  Tileset.findOneAndUpdate({owner, tilesetId}, update, {new: true}, (err, tileset) => {
    if (err) return next(err)
    if (!tileset) res.sendStatus(404)

    res.json(tileset)
  })
}


module.exports.delete = function(req, res, next) {
  const owner = req.params.owner
  const tilesetId = req.params.tilesetId
  const tilesetPath = path.join('tilesets', owner, tilesetId)

  Tileset.findOneAndRemove({owner, tilesetId}, (err, tileset) => {
    if (err) return next(err)
    if (!tileset) return res.sendStatus(404)

    fs.unlink(tilesetPath, err => {
      if (err) return next(err)

      res.sendStatus(204)
    })
  })
}


module.exports.getTile = function(req, res, next) {
  const owner = req.params.owner
  const tilesetId = req.params.tilesetId
  const z = +req.params.z || 0
  const x = +req.params.x || 0
  const y = +req.params.y || 0

  const tilesetPath = path.join('tilesets', owner, tilesetId)
  const source = 'mbtiles://' + path.resolve(tilesetPath)
  tilelive.load(source, (err, source) => {
    if (err) return next(err)

    source.getTile(z, x, y, (err, data, headers) => {
      if (err) return next(err)

      res.set(headers)
      res.send(data)
    })
  })
}