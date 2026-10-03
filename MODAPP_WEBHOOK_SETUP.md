# Staff Application Form Setup

1. Add these variables to the bot environment:

```env
MODAPP_URL=https://sinfultpai.up.railway.app/modapp
MODAPP_CHANNEL_ID=1555973537582284831
# Optional: set this only if you also want a shared secret for API submissions
# MODAPP_SECRET=change-me
MODAPP_PORT=8080
# Optional:
MODAPP_STAFF_ROLE_ID=your_staff_role_id
```

2. Start the bot. It serves the application form at:

```text
GET https://sinfultpai.up.railway.app/modapp
```

3. It accepts submissions at:

```text
POST https://sinfultpai.up.railway.app/modapp
```

4. Each submission is sent to Discord channel `1555973537582284831` as an embed with **Accept** / **Decline** buttons.

Accept/decline reviews require the owner, Manage Server permission, or `MODAPP_STAFF_ROLE_ID`.
