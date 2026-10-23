"""Pagination: Calendly uses cursor-based paging.

Each list response has a `collection` and a `pagination` object. We request
the maximum page size (count=100) and keep passing `pagination.next_page_token`
as `page_token` until it is null. `max_pages` lets a limited production run
fetch only the first page.
"""

PAGE_SIZE = 100


def fetch_all(client, path, params, logger, max_pages=None):
    params = {**params, "count": PAGE_SIZE}
    page = 0
    while True:
        page += 1
        data = client.get(path, params=params)
        records = data.get("collection", [])
        logger.info("page fetched", extra={"path": path, "page": page, "records": len(records)})
        yield from records

        token = (data.get("pagination") or {}).get("next_page_token")
        if not token or (max_pages and page >= max_pages):
            break
        params = {**params, "page_token": token}
