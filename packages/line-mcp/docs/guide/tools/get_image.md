# get_image

**When to use:** When a message returned by `get_messages` contains a `previewUrl` and you need to view the image.

**Prerequisites:** `get_messages` — the `url` parameter must be a `previewUrl` from a message, not a manually constructed URL.

**Next steps:** Depends on context — typically none; image viewing is a terminal step.

**Avoid:** Don't construct LINE image URLs manually. Only use URLs that appear verbatim in `get_messages` output — they carry auth tokens and expire.
