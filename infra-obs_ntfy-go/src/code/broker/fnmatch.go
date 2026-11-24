package broker

// fnmatch is Python's fnmatch.fnmatch on posix (case sensitive): * ? [seq] [!seq], full-string match, * and ? match
// any character including newline.
func fnmatch(name, pat string) bool {
	return match([]rune(name), []rune(pat))
}

func match(n, p []rune) bool {
	for len(p) > 0 {
		switch p[0] {
		case '*':
			for len(p) > 0 && p[0] == '*' {
				p = p[1:]
			}
			if len(p) == 0 {
				return true
			}
			for i := 0; i <= len(n); i++ {
				if match(n[i:], p) {
					return true
				}
			}
			return false
		case '?':
			if len(n) == 0 {
				return false
			}
			n, p = n[1:], p[1:]
		case '[':
			end, set, neg, ok := parseSet(p)
			if !ok {
				// no closing bracket: literal '['
				if len(n) == 0 || n[0] != '[' {
					return false
				}
				n, p = n[1:], p[1:]
				continue
			}
			if len(n) == 0 {
				return false
			}
			in := false
			for _, rg := range set {
				if n[0] >= rg[0] && n[0] <= rg[1] {
					in = true
					break
				}
			}
			if in == neg {
				return false
			}
			n, p = n[1:], p[end:]
		default:
			if len(n) == 0 || n[0] != p[0] {
				return false
			}
			n, p = n[1:], p[1:]
		}
	}
	return len(n) == 0
}

// parseSet parses a bracket expression starting at p[0]=='['. It returns the number of runes consumed.
func parseSet(p []rune) (end int, set [][2]rune, neg bool, ok bool) {
	i := 1
	if i < len(p) && p[i] == '!' {
		neg = true
		i++
	}
	first := true
	for i < len(p) {
		if p[i] == ']' && !first {
			return i + 1, set, neg, true
		}
		first = false
		lo := p[i]
		if i+2 < len(p) && p[i+1] == '-' && p[i+2] != ']' {
			set = append(set, [2]rune{lo, p[i+2]})
			i += 3
			continue
		}
		set = append(set, [2]rune{lo, lo})
		i++
	}
	return 0, nil, false, false
}
