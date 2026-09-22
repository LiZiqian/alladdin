"""Business status text normalization must preserve resource addresses."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server_modules import status_normalization


class StatusPathIntegrityTests(unittest.TestCase):
    def test_result_photo_thumbnail_urls_and_paths_are_never_status_text(self):
        photo = {"id": "photo", "url": "/api/photos/PASS", "thumbUrl": "/api/photos/PASS-thumb",
                 "thumbRelativePath": "photos/Fail/thumb.png", "download_url": "/api/Testing/download"}
        task = {"id": "t", "status": "进行中", "resultPhotos": [copy.deepcopy(photo)],
                "resultDraft": {"result": "通过", "samples": [{"resultPhotos": [copy.deepcopy(photo)]}]}}
        normalized = status_normalization.normalize_task_payload(task)
        self.assertEqual(normalized["resultPhotos"], [photo])
        self.assertEqual(normalized["resultDraft"]["samples"][0]["resultPhotos"], [photo])
        self.assertEqual(normalized["status"], "进行中")
        self.assertEqual(normalized["resultDraft"]["result"], "通过")
        self.assertEqual(task["status"], "进行中")

    def test_protected_address_suffixes_keep_business_text_normalization_active(self):
        source = {"asset-path": "sample/OK/file", "imageURL": "/PASS/Testing",
                  "photoUrls": ["/PASS/one", "/Fail/two"], "thumb_paths": ["/Testing/one"],
                  "notes": "PASS; FAIL; OK; BOOK; TOKEN"}
        actual = status_normalization.normalize_sample_payload(source)
        self.assertEqual({key: value for key, value in actual.items() if key in source and key != "notes"},
                         {key: value for key, value in source.items() if key != "notes"})
        self.assertEqual(actual["notes"], "PASS; FAIL; OK; BOOK; TOKEN")


if __name__ == "__main__":
    unittest.main()
