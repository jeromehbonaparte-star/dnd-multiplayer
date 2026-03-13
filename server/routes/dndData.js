/**
 * D&D Data Routes
 * Proxies D&D 5e API data with SQLite caching
 */

const express = require('express');

function createDndDataRoutes(db, auth) {
  const router = express.Router();
  const { checkPassword } = auth;
  const dndData = require('../services/dndDataService');

  router.get('/races', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getRaces(db));
    } catch (e) {
      next(e);
    }
  });

  router.get('/classes', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getClasses(db));
    } catch (e) {
      next(e);
    }
  });

  router.get('/classes/:classIndex/spells', checkPassword, async (req, res, next) => {
    try {
      const level = parseInt(req.query.level) || 0;
      res.json(await dndData.getSpellsByClass(db, req.params.classIndex, level));
    } catch (e) {
      next(e);
    }
  });

  router.get('/spells/:spellIndex', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getSpellDetail(db, req.params.spellIndex));
    } catch (e) {
      next(e);
    }
  });

  router.get('/equipment/:category', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getEquipmentByCategory(db, req.params.category));
    } catch (e) {
      next(e);
    }
  });

  router.get('/skills', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getSkills(db));
    } catch (e) {
      next(e);
    }
  });

  router.get('/backgrounds', checkPassword, async (req, res, next) => {
    try {
      res.json(await dndData.getBackgrounds(db));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createDndDataRoutes };
