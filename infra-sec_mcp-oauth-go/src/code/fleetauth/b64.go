package fleetauth

import "errors"

// ErrB64 is binascii.Error from a non-strict a2b_base64.
var ErrB64 = errors.New("binascii.Error")

var b64Table = func() [256]byte {
	var t [256]byte
	for i := range t {
		t[i] = 0xff
	}
	const std = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for i := 0; i < len(std); i++ {
		t[std[i]] = byte(i)
	}
	return t
}()

// B64URLDecode is PyJWT's base64url_decode: pad to a multiple of 4 (counting every byte),
// map -_ to +/, then CPython's non-strict binascii.a2b_base64, which skips bytes outside the
// alphabet and stops at a complete pad sequence.
func B64URLDecode(in []byte) ([]byte, error) {
	s := make([]byte, 0, len(in)+3)
	for _, c := range in {
		switch c {
		case '-':
			c = '+'
		case '_':
			c = '/'
		}
		s = append(s, c)
	}
	if r := len(in) % 4; r > 0 {
		for i := 0; i < 4-r; i++ {
			s = append(s, '=')
		}
	}
	out := make([]byte, 0, len(s)*3/4)
	var quadPos, pads int
	var left byte
	for _, c := range s {
		if c == '=' {
			if quadPos >= 2 {
				pads++
				if quadPos+pads >= 4 {
					return out, nil
				}
			}
			continue
		}
		v := b64Table[c]
		if v >= 64 {
			continue
		}
		pads = 0
		switch quadPos {
		case 0:
			quadPos, left = 1, v
		case 1:
			quadPos = 2
			out = append(out, left<<2|v>>4)
			left = v & 0x0f
		case 2:
			quadPos = 3
			out = append(out, left<<4|v>>2)
			left = v & 0x03
		case 3:
			quadPos = 0
			out = append(out, left<<6|v)
			left = 0
		}
	}
	if quadPos != 0 {
		return nil, ErrB64
	}
	return out, nil
}
