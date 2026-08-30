const db = require('../db');

function checkAccess(requiredLevel = 'read') {
    return async (req, res, next) => {
        const userId = req.user.user_id;
        const role   = req.user.role;
        const targetId = req.params.targetId || req.body.targetId || req.query.targetId;

        // 1. Admin bypass
        if (role === 'admin') return next();

        if (!targetId) return res.status(400).json({ error: 'targetId is required' });

        // 2. Fetch direct permissions for this target
        try {
            const perms = await db.all(`
                SELECT can_read, can_write, can_delete FROM permissions 
                WHERE subject_id = ? AND target_id = ?
            `, [userId, targetId]);

            if (!perms || perms.length === 0) {
                return res.status(403).json({ error: 'Forbidden: No access to this target' });
            }

            // 3. Level-based check
            const canRead   = perms.some(p => Number(p.can_read) === 1);
            const canWrite  = perms.some(p => Number(p.can_write) === 1);
            const canDelete = perms.some(p => Number(p.can_delete) === 1);

            if (requiredLevel === 'read'   && !canRead)   return res.status(403).json({ error: 'Forbidden: Read access denied' });
            if (requiredLevel === 'write'  && !canWrite)  return res.status(403).json({ error: 'Forbidden: Write access denied' });
            if (requiredLevel === 'delete' && !canDelete) return res.status(403).json({ error: 'Forbidden: Delete access denied' });

            next();
        } catch (err) {
            return res.status(500).json({ error: 'Permission verification error' });
        }
    };
}

module.exports = { checkAccess };
