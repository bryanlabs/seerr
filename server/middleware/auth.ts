import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type {
  Permission,
  PermissionCheckOptions,
} from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { timingSafeEqual } from 'node:crypto';

// Bryanlabs fork: a second API key that can only file and follow book
// requests on behalf of a named user (Book Chat). It is read from
// BOOK_REQUEST_API_KEY and is off when that is unset. Everything it may reach
// is listed in BOOK_REQUEST_ROUTES; restrictScopedApiKey rejects the rest.
const isBookRequestKey = (header: string | undefined): boolean => {
  const key = process.env.BOOK_REQUEST_API_KEY;
  if (!key || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

const findScopedUser = async (who: string | undefined) => {
  if (!who) return null;
  const userRepository = getRepository(User);
  if (/^\d+$/.test(who)) {
    return userRepository.findOne({ where: { id: Number(who) } });
  }
  return (
    (await userRepository.findOne({ where: { username: who } })) ??
    (await userRepository.findOne({ where: { plexUsername: who } }))
  );
};

const BOOK_REQUEST_ROUTES: { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/(audiobook|ebook)\/search$/ },
  { method: 'GET', path: /^\/(audiobook|ebook)\/\d+$/ },
  { method: 'POST', path: /^\/(audiobook|ebook)\/request$/ },
  { method: 'GET', path: /^\/auth\/me$/ },
];

export const restrictScopedApiKey: Middleware = (req, res, next) => {
  if (req.apiScope !== 'book-request') {
    return next();
  }
  const quota = req.path.match(/^\/user\/(\d+)\/quota$/);
  const allowed =
    (req.method === 'GET' && quota && Number(quota[1]) === req.user?.id) ||
    BOOK_REQUEST_ROUTES.some(
      (r) => r.method === req.method && r.path.test(req.path)
    );
  if (!req.user || !allowed) {
    res.status(403).json({
      status: 403,
      error: 'This API key can only request books',
    });
    return;
  }
  if (req.method === 'POST') {
    // The configured server, quality profile, folder and tags always apply.
    const { foreignBookId, foreignAuthorId, authorName } = req.body ?? {};
    req.body = { foreignBookId, foreignAuthorId, authorName };
  }
  next();
};

export const checkUser: Middleware = async (req, _res, next) => {
  const settings = getSettings();
  let user: User | undefined | null;

  if (isBookRequestKey(req.header('X-API-Key'))) {
    user = await findScopedUser(req.header('X-API-User'));
    req.apiScope = 'book-request';
  } else if (req.header('X-API-Key') === settings.main.apiKey) {
    const userRepository = getRepository(User);

    let userId = 1; // Work on original administrator account

    // If a User ID is provided, we will act on that user's behalf
    if (req.header('X-API-User')) {
      userId = Number(req.header('X-API-User'));
    }

    user = await userRepository.findOne({ where: { id: userId } });
  } else if (req.session?.userId) {
    const userRepository = getRepository(User);

    user = await userRepository.findOne({
      where: { id: req.session.userId },
    });
  }

  if (user) {
    req.user = user;
  }

  req.locale = user?.settings?.locale
    ? user.settings.locale
    : settings.main.locale;

  next();
};

export const isAuthenticated = (
  permissions?: Permission | Permission[],
  options?: PermissionCheckOptions
): Middleware => {
  const authMiddleware: Middleware = (req, res, next) => {
    if (!req.user || !req.user.hasPermission(permissions ?? 0, options)) {
      res.status(403).json({
        status: 403,
        error: 'You do not have permission to access this endpoint',
      });
    } else {
      next();
    }
  };
  return authMiddleware;
};
