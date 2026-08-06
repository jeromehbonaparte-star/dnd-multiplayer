/**
 * D&D Data Routes
 * Proxies D&D 5e API data with SQLite caching
 */

const express = require('express');

function createDndDataRoutes(db, auth) {
  const router = express.Router();
  const { requireUser } = auth;
  const dndData = require('../services/dndDataService');

  router.get('/races', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getRaces(db));
    } catch (e) {
      next(e);
    }
  });

  router.get('/classes', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getClasses(db));
    } catch (e) {
      next(e);
    }
  });

  // Unknown or subclass-less classes return an empty array, mirroring the
  // permissive handling of the other static-data routes.
  router.get('/classes/:classIndex/subclasses', requireUser, async (req, res, next) => {
    try {
      res.json(dndData.getSubclasses(req.params.classIndex));
    } catch (e) {
      next(e);
    }
  });

  router.get('/subclasses', requireUser, async (req, res, next) => {
    try {
      res.json(dndData.getAllSubclasses());
    } catch (e) {
      next(e);
    }
  });

  router.get('/classes/:classIndex/spells', requireUser, async (req, res, next) => {
    try {
      const level = parseInt(req.query.level) || 0;
      res.json(await dndData.getSpellsByClass(db, req.params.classIndex, level));
    } catch (e) {
      next(e);
    }
  });

  router.get('/spells/:spellIndex', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getSpellDetail(db, req.params.spellIndex));
    } catch (e) {
      next(e);
    }
  });

  router.get('/equipment/:category', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getEquipmentByCategory(db, req.params.category));
    } catch (e) {
      next(e);
    }
  });

  router.get('/skills', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getSkills(db));
    } catch (e) {
      next(e);
    }
  });

  router.get('/backgrounds', requireUser, async (req, res, next) => {
    try {
      res.json(await dndData.getBackgrounds(db));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createDndDataRoutes };
