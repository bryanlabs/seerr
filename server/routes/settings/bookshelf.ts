import BookshelfAPI from '@server/api/servarr/bookshelf';
import type { BookshelfSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { Router } from 'express';

const bookshelfRoutes = Router();

bookshelfRoutes.get('/', (_req, res) => {
  const settings = getSettings();
  res.status(200).json(settings.bookshelf);
});

bookshelfRoutes.post('/', async (req, res) => {
  const settings = getSettings();

  const newBookshelf = req.body as BookshelfSettings;
  const lastItem = settings.bookshelf[settings.bookshelf.length - 1];
  newBookshelf.id = lastItem ? lastItem.id + 1 : 0;

  // Only clear isDefault from other instances of the same mediaType
  if (req.body.isDefault) {
    settings.bookshelf
      .filter((inst) => inst.mediaType === newBookshelf.mediaType)
      .forEach((inst) => {
        inst.isDefault = false;
      });
  }

  settings.bookshelf = [...settings.bookshelf, newBookshelf];
  await settings.save();

  return res.status(201).json(newBookshelf);
});

bookshelfRoutes.post('/test', async (req, res, next) => {
  try {
    const bookshelf = new BookshelfAPI({
      apiKey: req.body.apiKey,
      url: BookshelfAPI.buildUrl(req.body, '/api/v1'),
    });

    const systemStatus = await bookshelf.getSystemStatus();
    const urlBase = systemStatus.urlBase;
    const profiles = await bookshelf.getProfiles();
    const metadataProfiles = await bookshelf.getMetadataProfiles();
    const folders = await bookshelf.getRootFolders();
    const tags = await bookshelf.getTags();

    return res.status(200).json({
      profiles,
      metadataProfiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Bookshelf', {
      label: 'Bookshelf',
      message: e.message,
    });
    next({ status: 500, message: 'Failed to connect to Bookshelf' });
  }
});

bookshelfRoutes.put<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const index = settings.bookshelf.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (index === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  if (req.body.isDefault) {
    settings.bookshelf
      .filter((inst) => inst.mediaType === req.body.mediaType)
      .forEach((inst) => {
        inst.isDefault = false;
      });
  }

  settings.bookshelf[index] = {
    ...req.body,
    id: Number(req.params.id),
  } as BookshelfSettings;
  await settings.save();

  return res.status(200).json(settings.bookshelf[index]);
});

bookshelfRoutes.delete<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const index = settings.bookshelf.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (index === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.bookshelf.splice(index, 1);
  await settings.save();

  return res.status(200).json(removed[0]);
});

export default bookshelfRoutes;
