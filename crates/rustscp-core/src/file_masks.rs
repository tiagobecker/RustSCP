use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// WinSCP-style file mask: `*.txt; *.html; !*.bak` (`;`-separated, `!` excludes,
/// `*` and `?` wildcards). Matching is case-insensitive by default, like WinSCP and the
/// default macOS/Windows file systems.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMaskFilter {
    pub raw_mask: String,
    #[serde(skip)]
    include_patterns: Vec<Regex>,
    #[serde(skip)]
    exclude_patterns: Vec<Regex>,
    /// True when the mask listed include patterns, even if none of them compiled: such a
    /// mask then matches nothing instead of everything.
    #[serde(skip)]
    has_include: bool,
    /// Patterns that could not be compiled (so the UI can flag the mask).
    #[serde(skip)]
    invalid_patterns: Vec<String>,
}

impl FileMaskFilter {
    /// Case-insensitive mask (WinSCP behaviour).
    pub fn new(mask_str: &str) -> Self {
        Self::with_case_sensitivity(mask_str, false)
    }

    /// Mask with explicit case sensitivity.
    pub fn with_case_sensitivity(mask_str: &str, case_sensitive: bool) -> Self {
        let mut include = Vec::new();
        let mut exclude = Vec::new();
        let mut has_include = false;
        let mut invalid = Vec::new();

        for part in mask_str
            .split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            let (is_exclude, clean_pattern) = if let Some(stripped) = part.strip_prefix('!') {
                (true, stripped.trim())
            } else {
                (false, part)
            };
            if clean_pattern.is_empty() {
                continue;
            }
            if !is_exclude {
                has_include = true;
            }

            let regex_str = wildcard_to_regex(clean_pattern);
            match RegexBuilder::new(&regex_str)
                .case_insensitive(!case_sensitive)
                .build()
            {
                Ok(re) => {
                    if is_exclude {
                        exclude.push(re);
                    } else {
                        include.push(re);
                    }
                }
                Err(_) => invalid.push(part.to_string()),
            }
        }

        Self {
            raw_mask: mask_str.to_string(),
            include_patterns: include,
            exclude_patterns: exclude,
            has_include,
            invalid_patterns: invalid,
        }
    }

    /// Patterns of the mask that could not be compiled.
    pub fn invalid_patterns(&self) -> &[String] {
        &self.invalid_patterns
    }

    /// True when every pattern of the mask compiled.
    pub fn is_valid(&self) -> bool {
        self.invalid_patterns.is_empty()
    }

    /// Checks if a file or directory matches the mask rules
    pub fn matches(&self, filename: &str, _is_dir: bool) -> bool {
        // If there are exclude rules and any matches, reject
        if self.exclude_patterns.iter().any(|ex| ex.is_match(filename)) {
            return false;
        }

        // If there are include rules, at least one must match
        if self.has_include {
            return self.include_patterns.iter().any(|inc| inc.is_match(filename));
        }

        true
    }
}

fn wildcard_to_regex(wildcard: &str) -> String {
    let mut regex = String::from("^");
    for ch in wildcard.chars() {
        match ch {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            c => regex.push_str(&regex::escape(c.encode_utf8(&mut [0u8; 4]))),
        }
    }
    regex.push('$');
    regex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_mask_matching() {
        let filter = FileMaskFilter::new("*.txt; *.html; !*.bak; !.git*");
        assert!(filter.matches("index.html", false));
        assert!(filter.matches("notes.txt", false));
        assert!(!filter.matches("backup.bak", false));
        assert!(!filter.matches(".git", true));
        assert!(!filter.matches("app.exe", false));
    }

    #[test]
    fn test_masks_are_case_insensitive_by_default() {
        let filter = FileMaskFilter::new("*.JPG; !*.BAK");
        assert!(filter.matches("photo.jpg", false));
        assert!(filter.matches("PHOTO.JPG", false));
        let ex = FileMaskFilter::new("!*.BAK");
        assert!(!ex.matches("old.bak", false));
        assert!(ex.matches("new.txt", false));

        let strict = FileMaskFilter::with_case_sensitivity("*.JPG", true);
        assert!(!strict.matches("photo.jpg", false));
        assert!(strict.matches("photo.JPG", false));
    }

    #[test]
    fn test_special_characters_are_literal() {
        let filter = FileMaskFilter::new("a+b (1).txt; report-#?.csv");
        assert!(filter.matches("a+b (1).txt", false));
        assert!(!filter.matches("aab (1).txt", false));
        assert!(filter.matches("report-#7.csv", false));
        assert!(filter.is_valid());
        assert!(filter.invalid_patterns().is_empty());
    }

    #[test]
    fn test_empty_and_exclude_only_masks() {
        assert!(FileMaskFilter::new("").matches("anything", false));
        assert!(FileMaskFilter::new(" ; ").matches("anything", false));
        assert!(FileMaskFilter::new("!").matches("anything", false));
        let ex = FileMaskFilter::new("!node_modules");
        assert!(!ex.matches("node_modules", true));
        assert!(ex.matches("src", true));
    }
}
