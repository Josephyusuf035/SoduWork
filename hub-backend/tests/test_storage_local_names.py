"""Local storage adapter regressions: injective, filesystem-safe key mapping."""
import unittest

from app.services import storage


class LocalKeyNameTests(unittest.TestCase):
    def test_separator_replacement_is_injective_again(self):
        # The old replace("/", "__") mapping collapsed distinct keys onto one
        # local file, so one of the two objects could never be read back.
        self.assertNotEqual(
            storage._local_path("att/task/a__b/name.txt"),
            storage._local_path("att/task/a/b/name.txt"))

    def test_local_names_never_contain_path_or_drive_colon_characters(self):
        for key in ("att/task/report:ads.pdf", "att/task/a/b/c.txt",
                    "att/task/back\\slash.txt", "att/task/..\\..\\x"):
            name = storage.local_name(key)
            self.assertNotIn("/", name)
            self.assertNotIn("\\", name)
            self.assertNotIn(":", name)
            self.assertEqual(storage.local_name(key), name)

    def test_percent_in_the_key_round_trips_without_ambiguity(self):
        self.assertNotEqual(storage.local_name("att/x/100%file"),
                            storage.local_name("att/x/100%25file"))

    def test_mapping_is_deterministic_across_calls(self):
        # The same key always maps to the same local file name, so objects
        # written earlier in the process lifetime stay readable.
        for key in ("att/task/id/file.txt", "delivery.bin", "att/task/报告.pdf"):
            self.assertEqual(storage.local_name(key), storage.local_name(key))


if __name__ == "__main__":
    unittest.main()
