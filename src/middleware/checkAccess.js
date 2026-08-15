const Database = require('better-sqlite3');
const db = new Database('./data/metadata.db');

function checkAccess(requiredLevel = 'read') {
    return (req, res, next) => {
        const userId = req.user.user_id;
        const role   = req.user.role;
        const targetId = req.params.targetId || req.body.targetId || req.query.targetId;

        // 1. Admin bypass
        if (role === 'admin') return next();

        if (!targetId) return res.status(400).json({ error: 'targetId is required' });

        // 2. Fetch direct + group permissions for this target
        const perms = db.prepare(`
            -- User direct permissions
            SELECT can_read, can_write, can_delete FROM permissions 
            WHERE subject_id = ? AND subject_type = 'user' AND target_id = ?
            UNION
            -- User group permissions
            SELECT can_read, can_write, can_delete FROM permissions
            INNER JOIN user_groups ON permissions.subject_id = user_groups.group_id
            WHERE user_groups.user_id = ? AND permissions.subject_type = 'group' AND permissions.target_id = ?
        `).all(userId, targetId, userId, targetId);

        if (!perms || perms.length === 0) {
            return res.status(403).json({ error: 'Forbidden: No access to this target' });
        }

        // 3. Level-based check
        const canRead   = perms.some(p => p.can_read === 1);
        const canWrite  = perms.some(p => p.can_write === 1);
        const canDelete = perms.some(p => p.can_delete === 1);

        if (requiredLevel === 'read'   && !canRead)   return res.status(403).json({ error: 'Forbidden: Read access denied' });
        if (requiredLevel === 'write'  && !canWrite)  return res.status(403).json({ error: 'Forbidden: Write access denied' });
        if (requiredLevel === 'delete' && !canDelete) return res.status(403).json({ error: 'Forbidden: Delete access denied' });

        next();
    };
}

module.exports = { checkAccess };
